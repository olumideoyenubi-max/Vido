import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.js';
import { createMockProvider } from '../src/providers/mock.js';
import { MODELS } from '../src/models.js';

const waitFor = async (check, timeout = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const mockModel = MODELS.find((m) => m.id === 'mock');
const request = { model: 'mock', prompt: 'a red fox in snow', aspectRatio: '9:16', duration: 5 };

// A model on a fake backend that records what it was sent.
function fakeSetup(backend, extra = {}) {
  const model = { ...mockModel, id: 'fake', name: 'Fake', backend: 'fake', endpoint: () => 'ep', input: (r) => ({ p: r.prompt }) };
  return new JobStore({ backends: { fake: backend }, models: [model], pollIntervalMs: 5, ...extra });
}
const fakeRequest = { ...request, model: 'fake' };

test('runs a job to completion and persists it', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'vido-')), 'jobs.json');
  const backends = { mock: createMockProvider({ durationMs: 50 }) };
  const store = new JobStore({ backends, models: [mockModel], file, pollIntervalMs: 10 });

  const job = await store.create(request);
  assert.equal(job.status, 'queued');
  assert.equal(job.model, 'mock');
  assert.equal(job.modelName, 'Mock preview');
  assert.equal('externalId' in job, false);

  await waitFor(() => store.get(job.id).status === 'succeeded');
  const done = store.get(job.id);
  assert.equal(done.progress, 1);
  assert.equal(done.output.mimeType, 'image/svg+xml');
  assert.match(Buffer.from(done.output.url.split(',')[1], 'base64').toString(), /a red fox in snow/);

  await store.close();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved[0].status, 'succeeded');

  const reloaded = new JobStore({ backends, models: [mockModel], file });
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
});

test('sends the model endpoint and mapped input to the backend', async () => {
  const sent = [];
  const store = fakeSetup({ submit: async (x) => (sent.push(x), { externalId: 'e1', status: 'queued' }), poll: async () => ({ status: 'running' }) });
  await store.create(fakeRequest);
  assert.deepEqual(sent, [{ endpoint: 'ep', input: { p: 'a red fox in snow' } }]);
  await store.close();
});

test('copies finished videos into the media store', async () => {
  const saved = [];
  const media = { save: async (id, output) => (saved.push([id, output]), { url: `/media/${id}.mp4`, mimeType: 'video/mp4' }), remove: () => {} };
  const store = fakeSetup(
    {
      submit: async () => ({ externalId: 'e1', status: 'queued' }),
      poll: async () => ({ status: 'succeeded', output: { url: 'https://cdn/x.mp4', mimeType: 'video/mp4', headers: { A: 'b' } } }),
    },
    { media },
  );
  const job = await store.create(fakeRequest);
  await waitFor(() => store.get(job.id).status === 'succeeded');
  assert.equal(store.get(job.id).output.url, `/media/${job.id}.mp4`);
  assert.equal(saved[0][1].headers.A, 'b');
});

test('keeps a public provider link if saving fails, but fails private ones', async () => {
  const media = { save: async () => { throw new Error('disk full'); }, remove: () => {} };
  const withOutput = (output) => fakeSetup({ submit: async () => ({ externalId: 'e', status: 'succeeded', output }), poll: async () => ({}) }, { media });

  const pub = await withOutput({ url: 'https://cdn/x.mp4', mimeType: 'video/mp4' }).create(fakeRequest);
  assert.equal(pub.status, 'succeeded');
  assert.equal(pub.output.url, 'https://cdn/x.mp4');
  assert.equal(pub.output.headers, undefined);

  const priv = await withOutput({ url: 'http://worker/v', mimeType: 'video/mp4', headers: { Authorization: 'x' } }).create(fakeRequest);
  assert.equal(priv.status, 'failed');
  assert.match(priv.error, /disk full/);
});

test('marks the job failed when submit throws', async () => {
  const store = fakeSetup({ submit: async () => { throw new Error('quota exceeded'); }, poll: async () => ({}) });
  const job = await store.create(fakeRequest);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'quota exceeded');
});

test('fails after repeated poll errors', async () => {
  const store = fakeSetup({ submit: async () => ({ externalId: 'x', status: 'running' }), poll: async () => { throw new Error('network down'); } });
  const job = await store.create(fakeRequest);
  await waitFor(() => store.get(job.id).status === 'failed');
  assert.equal(store.get(job.id).error, 'network down');
});

test('fails jobs whose backend is no longer configured', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'vido-')), 'jobs.json');
  const first = fakeSetup({ submit: async () => ({ externalId: 'x', status: 'running' }), poll: async () => ({ status: 'running' }) }, { file });
  const job = await first.create(fakeRequest);
  await first.close();

  const second = new JobStore({ backends: {}, models: [], file, pollIntervalMs: 5 });
  await second.load();
  await waitFor(() => second.get(job.id).status === 'failed');
  assert.match(second.get(job.id).error, /fake backend is not configured/);
});

test('delete stops polling, removes media, and forgets the job', async () => {
  const removed = [];
  const store = new JobStore({
    backends: { mock: createMockProvider({ durationMs: 1000 }) },
    models: [mockModel],
    media: { save: async () => ({}), remove: (id) => removed.push(id) },
    pollIntervalMs: 10,
  });
  const job = await store.create(request);
  assert.equal(store.delete(job.id), true);
  assert.equal(store.get(job.id), undefined);
  assert.deepEqual(removed, [job.id]);
  assert.equal(store.delete(job.id), false);
  await store.close();
});

test('keeps at most maxJobs, dropping the oldest', async () => {
  const store = new JobStore({ backends: { mock: createMockProvider() }, models: [mockModel], maxJobs: 2 });
  const first = await store.create(request);
  await new Promise((r) => setTimeout(r, 2));
  await store.create(request);
  await new Promise((r) => setTimeout(r, 2));
  await store.create(request);
  assert.equal(store.list().length, 2);
  assert.equal(store.get(first.id), undefined);
  await store.close();
});
