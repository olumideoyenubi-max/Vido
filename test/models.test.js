import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, publicModel } from '../src/models.js';

const byId = (id) => MODELS.find((m) => m.id === id);
const base = { prompt: 'a fox', aspectRatio: '16:9', duration: 5 };

test('every model is well formed', () => {
  const ids = new Set();
  for (const m of MODELS) {
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    assert.ok(m.aspectRatios.length && m.durations.length, m.id);
    assert.equal(typeof m.endpoint(base), 'string');
    assert.equal(m.input(base).prompt, 'a fox');
    const pub = publicModel(m);
    assert.equal(pub.endpoint, undefined);
    assert.equal(pub.input, undefined);
  }
});

test('Wan 2.2 on fal picks the endpoint from image and LoRA use', () => {
  const wan = byId('wan-2.2-a14b');
  assert.equal(wan.endpoint(base), 'fal-ai/wan/v2.2-a14b/text-to-video');
  assert.equal(wan.endpoint({ ...base, image: 'data:' }), 'fal-ai/wan/v2.2-a14b/image-to-video');
  assert.equal(wan.endpoint({ ...base, lora: { path: 'a/b', scale: 1 } }), 'fal-ai/wan/v2.2-a14b/text-to-video/lora');
  assert.equal(wan.endpoint({ ...base, image: 'data:', lora: { path: 'a/b', scale: 1 } }), 'fal-ai/wan/v2.2-a14b/image-to-video/lora');
});

test('Wan 2.2 on fal maps duration to frames and passes LoRAs', () => {
  const wan = byId('wan-2.2-a14b');
  assert.deepEqual(wan.input({ ...base, duration: 10, seed: 3, negativePrompt: 'blur', lora: { path: 'https://x/l.safetensors', scale: 0.5 } }), {
    prompt: 'a fox',
    negative_prompt: 'blur',
    aspect_ratio: '16:9',
    resolution: '720p',
    frames_per_second: 16,
    num_frames: 161,
    seed: 3,
    loras: [{ path: 'https://x/l.safetensors', scale: 0.5 }],
  });
  const i2v = wan.input({ ...base, image: 'data:image/png;base64,AA==' });
  assert.equal(i2v.image_url, 'data:image/png;base64,AA==');
  assert.equal(i2v.aspect_ratio, 'auto');
});

test('local models send Vido field names to the worker', () => {
  const ltx = byId('ltx-2-local');
  assert.equal(ltx.endpoint(base), 'ltx-2');
  assert.deepEqual(ltx.input({ ...base, lora: { path: 'a/b', scale: 1 } }), {
    prompt: 'a fox',
    aspect_ratio: '16:9',
    duration: 5,
    lora: { path: 'a/b', scale: 1 },
  });
});
