import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const EXTENSIONS = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));
const FILE_NAME = /^[\w-]+\.(mp4|webm|mov)$/;

// Copies finished videos out of provider storage (Replicate deletes outputs
// after about an hour) into a local folder, and serves them with Range
// support so the browser's player can seek.
export class MediaStore {
  constructor({ dir, fetchImpl = fetch, maxBytes = 1024 ** 3 }) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.maxBytes = maxBytes;
  }

  // Returns the output to record on the job: a local /media/ URL when the
  // copy worked. Inline data: URLs (the mock backend) are kept as they are.
  async save(id, { url, mimeType, headers }) {
    if (url.startsWith('data:')) return { url, mimeType };

    const res = await this.fetchImpl(url, { headers });
    if (!res.ok || !res.body) throw new Error(`download failed with HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? mimeType ?? '').split(';')[0].trim();
    const ext = EXTENSIONS[type] ?? EXTENSIONS[mimeType] ?? 'mp4';

    await mkdir(this.dir, { recursive: true });
    const name = `${id}.${ext}`;
    const tmp = join(this.dir, `${name}.part`);
    let size = 0;
    const limit = new Transform({
      transform: (chunk, _enc, done) => {
        size += chunk.length;
        done(size > this.maxBytes ? new Error('video is larger than the size limit') : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body), limit, createWriteStream(tmp));
      await rename(tmp, join(this.dir, name));
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return { url: `/media/${name}`, mimeType: TYPES[ext] };
  }

  async remove(id) {
    const files = await readdir(this.dir).catch(() => []);
    await Promise.all(files.filter((f) => f.startsWith(`${id}.`)).map((f) => unlink(join(this.dir, f)).catch(() => {})));
  }

  // Returns false when there is no such file, so the caller can 404.
  async serve(req, res, name) {
    if (!FILE_NAME.test(name)) return false;
    const file = join(this.dir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;

    const headers = {
      'Content-Type': TYPES[name.split('.').pop()],
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = info.size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end || start >= info.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return true;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
    }
    if (req.method === 'HEAD') res.end();
    else await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
    return true;
  }
}
