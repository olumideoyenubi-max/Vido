import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { JobStore } from '../src/jobs.js';
import { MediaStore } from '../src/media.js';
import { createMockProvider } from '../src/providers/mock.js';
import { MODELS } from '../src/models.js';

let server, base, store;

before(async () => {
  const models = MODELS.filter((m) => m.backend === 'mock');
  const dir = await mkdtemp(join(tmpdir(), 'vido-srv-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'abc.mp4'), 'video');
  const media = new MediaStore({ dir });
  store = new JobStore({ backends: { mock: createMockProvider({ durationMs: 30 }) }, models, media, pollIntervalMs: 10 });
  server = createServer(createApp({ models, store, media }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await store.close();
  server.close();
});

const post = (body) => fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('serves the UI and the available models', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Vido/);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.models.map((m) => m.id), ['mock']);
  assert.equal(config.models[0].endpoint, undefined);
  assert.equal(config.maxPromptLength, 2000);
});

test('generate -> poll -> list -> delete', async () => {
  const res = await post({ model: 'mock', prompt: 'waves at dusk', aspectRatio: '1:1', duration: 10 });
  assert.equal(res.status, 202);
  const job = await res.json();

  let current = job;
  for (let i = 0; i < 100 && current.status !== 'succeeded'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    current = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
  }
  assert.equal(current.status, 'succeeded');

  const list = await (await fetch(`${base}/api/jobs`)).json();
  assert.ok(list.some((j) => j.id === job.id));

  assert.equal((await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}`)).status, 404);
});

test('rejects invalid requests', async () => {
  const res = await post({ prompt: '' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /prompt/);

  const unavailable = await post({ prompt: 'x', model: 'wan-2.2-a14b' });
  assert.equal(unavailable.status, 400);
  assert.match((await unavailable.json()).error, /model must be one of mock/);

  const bad = await fetch(`${base}/api/generate`, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);

  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test('serves saved media', async () => {
  const res = await fetch(`${base}/media/abc.mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(await res.text(), 'video');
  assert.equal((await fetch(`${base}/media/nope.mp4`)).status, 404);
});
