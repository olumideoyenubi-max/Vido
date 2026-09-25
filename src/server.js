import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackends } from './providers/index.js';
import { MODELS, publicModel } from './models.js';
import { JobStore } from './jobs.js';
import { MediaStore } from './media.js';
import { MAX_PROMPT_LENGTH, validateGenerateRequest } from './validate.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

async function serveStatic(req, res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Not found');
  let content;
  try {
    content = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : content);
}

export function createApp({ models, store, media }) {
  return async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { models: models.map(publicModel), maxPromptLength: MAX_PROMPT_LENGTH });
      }

      if (pathname === '/api/generate' && req.method === 'POST') {
        const { value, error } = validateGenerateRequest(await readJson(req), models);
        if (error) throw new HttpError(400, error);
        return sendJson(res, 202, await store.create(value));
      }

      if (pathname === '/api/jobs' && req.method === 'GET') {
        return sendJson(res, 200, store.list());
      }

      const jobMatch = /^\/api\/jobs\/([\w-]+)$/.exec(pathname);
      if (jobMatch && req.method === 'GET') {
        const job = store.get(jobMatch[1]);
        if (!job) throw new HttpError(404, 'Job not found');
        return sendJson(res, 200, job);
      }
      if (jobMatch && req.method === 'DELETE') {
        if (!store.delete(jobMatch[1])) throw new HttpError(404, 'Job not found');
        res.writeHead(204).end();
        return;
      }

      if (pathname.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
        if (media && (await media.serve(req, res, pathname.slice('/media/'.length)))) return;
        throw new HttpError(404, 'Not found');
      }

      if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      await serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  };
}

async function main() {
  const backends = createBackends();
  const models = MODELS.filter((m) => backends[m.backend]);
  const dataDir = process.env.DATA_DIR ?? join(ROOT, 'data');
  const media = new MediaStore({ dir: join(dataDir, 'media') });
  const store = new JobStore({ backends, models, media, file: join(dataDir, 'jobs.json') });
  await store.load();

  const port = Number(process.env.PORT ?? 3000);
  const server = createServer(createApp({ models, store, media }));
  server.listen(port, () => {
    console.log(`Vido running at http://localhost:${port}`);
    console.log(`Models: ${models.map((m) => `${m.name} [${m.backend}]`).join(', ')}`);
  });

  const shutdown = async () => {
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
