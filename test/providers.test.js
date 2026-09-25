import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplicateProvider } from '../src/providers/replicate.js';
import { createFalProvider } from '../src/providers/fal.js';
import { createProvider } from '../src/providers/index.js';

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
  const provider = createReplicateProvider({ token: 't', model: 'minimax/video-01', fetchImpl: impl });

  const submitted = await provider.submit({ prompt: 'hi', aspectRatio: '16:9', duration: 5 });
  assert.deepEqual(submitted, { externalId: 'p1', status: 'queued' });
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/minimax/video-01/predictions');
  assert.equal(calls[0].headers.Authorization, 'Bearer t');
  assert.deepEqual(calls[0].body, { input: { prompt: 'hi', aspect_ratio: '16:9', duration: 5 } });

  assert.equal((await provider.poll('p1')).status, 'running');
  assert.deepEqual(await provider.poll('p1'), { status: 'succeeded', output: { url: 'https://cdn.example/v.mp4', mimeType: 'video/mp4' } });
});

test('replicate: versioned model ids use the predictions endpoint', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { id: 'p2', status: 'starting' } }]);
  const provider = createReplicateProvider({ token: 't', model: 'owner/name:abc123', fetchImpl: impl });
  await provider.submit({ prompt: 'hi' });
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/predictions');
  assert.equal(calls[0].body.version, 'abc123');
});

test('replicate: surfaces API errors and failed predictions', async () => {
  const { impl } = fakeFetch([
    { status: 422, body: { detail: 'bad input' } },
    { body: { id: 'p1', status: 'failed', error: 'NSFW' } },
  ]);
  const provider = createReplicateProvider({ token: 't', model: 'a/b', fetchImpl: impl });
  await assert.rejects(provider.submit({ prompt: 'hi' }), /Replicate 422: bad input/);
  assert.deepEqual(await provider.poll('p1'), { status: 'failed', error: 'NSFW' });
});

test('fal: uses the queue API and switches model for image input', async () => {
  const { impl, calls } = fakeFetch([
    { body: { request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/r1' } },
    { body: { status: 'IN_PROGRESS' } },
    { body: { status: 'COMPLETED' } },
    { body: { video: { url: 'https://fal.media/v.mp4', content_type: 'video/mp4' } } },
  ]);
  const provider = createFalProvider({ key: 'k', model: 'fal-ai/kling-video/t2v', imageModel: 'fal-ai/kling-video/i2v', fetchImpl: impl });

  const { externalId } = await provider.submit({ prompt: 'hi', duration: 5, image: 'data:image/png;base64,AA==' });
  assert.equal(calls[0].url, 'https://queue.fal.run/fal-ai/kling-video/i2v');
  assert.equal(calls[0].headers.Authorization, 'Key k');
  assert.deepEqual(calls[0].body, { prompt: 'hi', duration: '5', image_url: 'data:image/png;base64,AA==' });

  assert.equal((await provider.poll(externalId)).status, 'running');
  const done = await provider.poll(externalId);
  assert.deepEqual(done, { status: 'succeeded', output: { url: 'https://fal.media/v.mp4', mimeType: 'video/mp4' } });
  assert.equal(calls[3].url, 'https://queue.fal.run/fal-ai/kling-video/requests/r1');
});

test('fal: can resume polling without cached URLs (after restart)', async () => {
  const { impl, calls } = fakeFetch([{ body: { status: 'IN_QUEUE' } }]);
  const provider = createFalProvider({ key: 'k', model: 'fal-ai/kling-video/t2v', fetchImpl: impl });
  assert.equal((await provider.poll('fal-ai/kling-video/t2v::r9')).status, 'queued');
  assert.equal(calls[0].url, 'https://queue.fal.run/fal-ai/kling-video/requests/r9/status');
});

test('createProvider validates configuration', () => {
  assert.equal(createProvider({}).name, 'mock');
  assert.throws(() => createProvider({ VIDEO_PROVIDER: 'replicate' }), /REPLICATE_API_TOKEN/);
  assert.throws(() => createProvider({ VIDEO_PROVIDER: 'fal' }), /FAL_KEY/);
  assert.throws(() => createProvider({ VIDEO_PROVIDER: 'nope' }), /Unknown VIDEO_PROVIDER/);
});
