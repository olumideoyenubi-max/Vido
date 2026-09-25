import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { JobStore } from '../src/jobs.js';
import { createMockProvider } from '../src/providers/mock.js';

let server, base, store;

before(async () => {
  const provider = createMockProvider({ durationMs: 30 });
  store = new JobStore({ provider, pollIntervalMs: 10 });
  server = createServer(createApp({ provider, store }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await store.close();
  server.close();
});

const post = (body) => fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('serves the UI and config', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Vido/);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.provider, 'mock');
  assert.deepEqual(config.aspectRatios, ['16:9', '9:16', '1:1']);
});

test('generate -> poll -> list -> delete', async () => {
  const res = await post({ prompt: 'waves at dusk', aspectRatio: '1:1', duration: 10 });
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

  const bad = await fetch(`${base}/api/generate`, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);

  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});
