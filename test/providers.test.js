import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplicateProvider } from '../src/providers/replicate.js';
import { createFalProvider } from '../src/providers/fal.js';
import { createLocalProvider } from '../src/providers/local.js';
import { createBackends } from '../src/providers/index.js';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body && JSON.parse(init.body) });
    const next = routes.shift();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { impl, calls };
}

test('replicate: submits to the model endpoint and returns the video URL', async () => {
  const { impl, calls } = fakeFetch([
    { status: 201, body: { id: 'p1', status: 'starting' } },
    { body: { id: 'p1', status: 'processing' } },
    { body: { id: 'p1', status: 'succeeded', output: 'https://cdn.example/v.mp4' } },
  ]);
  const provider = createReplicateProvider({ token: 't', fetchImpl: impl });

  const submitted = await provider.submit({ endpoint: 'wan-video/wan-2.2-t2v-fast', input: { prompt: 'hi' } });
  assert.deepEqual(submitted, { externalId: 'p1', status: 'queued' });
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/wan-video/wan-2.2-t2v-fast/predictions');
  assert.equal(calls[0].headers.Authorization, 'Bearer t');
  assert.deepEqual(calls[0].body, { input: { prompt: 'hi' } });

  assert.equal((await provider.poll('p1')).status, 'running');
  assert.deepEqual(await provider.poll('p1'), { status: 'succeeded', output: { url: 'https://cdn.example/v.mp4', mimeType: 'video/mp4' } });
});

test('replicate: versioned model ids use the predictions endpoint', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { id: 'p2', status: 'starting' } }]);
  const provider = createReplicateProvider({ token: 't', fetchImpl: impl });
  await provider.submit({ endpoint: 'owner/name:abc123', input: { prompt: 'hi' } });
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/predictions');
  assert.equal(calls[0].body.version, 'abc123');
});

test('replicate: surfaces API errors and failed predictions', async () => {
  const { impl } = fakeFetch([
    { status: 422, body: { detail: 'bad input' } },
    { body: { id: 'p1', status: 'failed', error: 'NSFW' } },
  ]);
  const provider = createReplicateProvider({ token: 't', fetchImpl: impl });
  await assert.rejects(provider.submit({ endpoint: 'a/b', input: {} }), /Replicate 422: bad input/);
  assert.deepEqual(await provider.poll('p1'), { status: 'failed', error: 'NSFW' });
});

test('fal: uses the queue API', async () => {
  const { impl, calls } = fakeFetch([
    { body: { request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/wan/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/wan/requests/r1' } },
    { body: { status: 'IN_PROGRESS' } },
    { body: { status: 'COMPLETED' } },
    { body: { video: { url: 'https://fal.media/v.mp4', content_type: 'video/mp4' } } },
  ]);
  const provider = createFalProvider({ key: 'k', fetchImpl: impl });

  const input = { prompt: 'hi', num_frames: 81 };
  const { externalId } = await provider.submit({ endpoint: 'fal-ai/wan/v2.2-a14b/text-to-video', input });
  assert.equal(calls[0].url, 'https://queue.fal.run/fal-ai/wan/v2.2-a14b/text-to-video');
  assert.equal(calls[0].headers.Authorization, 'Key k');
  assert.deepEqual(calls[0].body, input);

  assert.equal((await provider.poll(externalId)).status, 'running');
  const done = await provider.poll(externalId);
  assert.deepEqual(done, { status: 'succeeded', output: { url: 'https://fal.media/v.mp4', mimeType: 'video/mp4' } });
  assert.equal(calls[3].url, 'https://queue.fal.run/fal-ai/wan/requests/r1');
});

test('fal: can resume polling without cached URLs (after restart)', async () => {
  const { impl, calls } = fakeFetch([{ body: { status: 'IN_QUEUE' } }]);
  const provider = createFalProvider({ key: 'k', fetchImpl: impl });
  assert.equal((await provider.poll('fal-ai/wan/v2.2-a14b/text-to-video::r9')).status, 'queued');
  assert.equal(calls[0].url, 'https://queue.fal.run/fal-ai/wan/requests/r9/status');
});

test('local: talks to the worker API with its token', async () => {
  const { impl, calls } = fakeFetch([
    { status: 202, body: { id: 'j1', status: 'queued' } },
    { body: { id: 'j1', status: 'running', progress: 0.4 } },
    { body: { id: 'j1', status: 'succeeded', progress: 1 } },
    { body: { id: 'j1', status: 'failed', error: 'CUDA out of memory' } },
  ]);
  const provider = createLocalProvider({ url: 'http://gpu:8188/', token: 's', fetchImpl: impl });

  assert.deepEqual(await provider.submit({ endpoint: 'ltx-2', input: { prompt: 'hi', duration: 5 } }), { externalId: 'j1', status: 'queued' });
  assert.equal(calls[0].url, 'http://gpu:8188/jobs');
  assert.equal(calls[0].headers.Authorization, 'Bearer s');
  assert.deepEqual(calls[0].body, { model: 'ltx-2', prompt: 'hi', duration: 5 });

  assert.deepEqual(await provider.poll('j1'), { status: 'running', progress: 0.4 });
  assert.deepEqual(await provider.poll('j1'), {
    status: 'succeeded',
    output: { url: 'http://gpu:8188/jobs/j1/video', mimeType: 'video/mp4', headers: { Authorization: 'Bearer s' } },
  });
  assert.deepEqual(await provider.poll('j1'), { status: 'failed', error: 'CUDA out of memory' });
});

test('createBackends enables what is configured', () => {
  assert.deepEqual(Object.keys(createBackends({})), ['mock']);
  assert.deepEqual(Object.keys(createBackends({ FAL_KEY: 'k', LOCAL_WORKER_URL: 'http://x' })), ['fal', 'local']);
  assert.deepEqual(Object.keys(createBackends({ REPLICATE_API_TOKEN: 't', ENABLE_MOCK: 'true' })), ['replicate', 'mock']);
  assert.deepEqual(Object.keys(createBackends({ ENABLE_MOCK: 'false' })), []);
});
