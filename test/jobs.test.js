import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/jobs.js';
import { createMockProvider } from '../src/providers/mock.js';

const waitFor = async (check, timeout = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const request = { prompt: 'a red fox in snow', aspectRatio: '9:16', duration: 5 };

test('runs a job to completion and persists it', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'vido-')), 'jobs.json');
  const store = new JobStore({ provider: createMockProvider({ durationMs: 50 }), file, pollIntervalMs: 10 });

  const job = await store.create(request);
  assert.equal(job.status, 'queued');
  assert.equal('externalId' in job, false);

  await waitFor(() => store.get(job.id).status === 'succeeded');
  const done = store.get(job.id);
  assert.equal(done.progress, 1);
  assert.equal(done.output.mimeType, 'image/svg+xml');
  assert.match(Buffer.from(done.output.url.split(',')[1], 'base64').toString(), /a red fox in snow/);

  await store.close();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved[0].status, 'succeeded');

  const reloaded = new JobStore({ provider: createMockProvider(), file });
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
});

test('marks the job failed when submit throws', async () => {
  const provider = { name: 'broken', submit: async () => { throw new Error('quota exceeded'); }, poll: async () => ({}) };
  const store = new JobStore({ provider });
  const job = await store.create(request);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'quota exceeded');
});

test('fails after repeated poll errors', async () => {
  const provider = {
    name: 'flaky',
    submit: async () => ({ externalId: 'x', status: 'running' }),
    poll: async () => { throw new Error('network down'); },
  };
  const store = new JobStore({ provider, pollIntervalMs: 5 });
  const job = await store.create(request);
  await waitFor(() => store.get(job.id).status === 'failed');
  assert.equal(store.get(job.id).error, 'network down');
});

test('delete stops polling and removes the job', async () => {
  const store = new JobStore({ provider: createMockProvider({ durationMs: 1000 }), pollIntervalMs: 10 });
  const job = await store.create(request);
  assert.equal(store.delete(job.id), true);
  assert.equal(store.get(job.id), undefined);
  assert.equal(store.delete(job.id), false);
  await store.close();
});

test('keeps at most maxJobs, dropping the oldest', async () => {
  const store = new JobStore({ provider: createMockProvider(), maxJobs: 2 });
  const first = await store.create(request);
  await new Promise((r) => setTimeout(r, 2));
  await store.create(request);
  await new Promise((r) => setTimeout(r, 2));
  await store.create(request);
  assert.equal(store.list().length, 2);
  assert.equal(store.get(first.id), undefined);
  await store.close();
});
