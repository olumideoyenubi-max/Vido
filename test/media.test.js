import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore } from '../src/media.js';

const VIDEO = Buffer.from('0123456789abcdef');
let source, sourceUrl, dir, store, server, base;

before(async () => {
  // A stand-in for provider storage.
  source = createServer((req, res) => {
    if (req.url === '/private' && req.headers.authorization !== 'Bearer t') return res.writeHead(401).end();
    res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(VIDEO);
  });
  await new Promise((r) => source.listen(0, r));
  sourceUrl = `http://localhost:${source.address().port}`;

  dir = await mkdtemp(join(tmpdir(), 'vido-media-'));
  store = new MediaStore({ dir });
  server = createServer(async (req, res) => {
    if (!(await store.serve(req, res, req.url.slice(1)))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  source.close();
  server.close();
});

test('downloads a video and serves it with range support', async () => {
  const output = await store.save('job1', { url: `${sourceUrl}/v.mp4`, mimeType: 'video/mp4' });
  assert.deepEqual(output, { url: '/media/job1.mp4', mimeType: 'video/mp4' });

  const full = await fetch(`${base}/job1.mp4`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), VIDEO);

  const part = await fetch(`${base}/job1.mp4`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 2-5/${VIDEO.length}`);
  assert.equal(await part.text(), '2345');

  const tail = await fetch(`${base}/job1.mp4`, { headers: { Range: 'bytes=-3' } });
  assert.equal(await tail.text(), 'def');

  assert.equal((await fetch(`${base}/job1.mp4`, { headers: { Range: 'bytes=99-' } })).status, 416);
});

test('passes credentials and cleans up', async () => {
  await assert.rejects(store.save('job2', { url: `${sourceUrl}/private` }), /HTTP 401/);
  await store.save('job2', { url: `${sourceUrl}/private`, headers: { Authorization: 'Bearer t' } });
  assert.ok((await readdir(dir)).includes('job2.mp4'));
  await store.remove('job2');
  assert.ok(!(await readdir(dir)).includes('job2.mp4'));
  assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.part')));
});

test('keeps data URLs inline, enforces size limit, rejects odd names', async () => {
  const data = { url: 'data:image/svg+xml;base64,AA==', mimeType: 'image/svg+xml' };
  assert.deepEqual(await store.save('job3', data), data);

  const small = new MediaStore({ dir, maxBytes: 4 });
  await assert.rejects(small.save('job4', { url: `${sourceUrl}/v.mp4` }), /size limit/);
  assert.ok(!(await readdir(dir)).some((f) => f.startsWith('job4')));

  assert.equal((await fetch(`${base}/..%2Fetc%2Fpasswd`)).status, 404);
  assert.equal((await fetch(`${base}/missing.mp4`)).status, 404);
});
