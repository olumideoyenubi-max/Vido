import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGenerateRequest } from '../src/validate.js';
import { MODELS } from '../src/models.js';

const models = MODELS;
const byId = (id) => MODELS.find((m) => m.id === id);

test('defaults to the first model and its first options', () => {
  const { value, error } = validateGenerateRequest({ prompt: '  a cat  ' }, models);
  assert.equal(error, undefined);
  assert.deepEqual(value, {
    model: models[0].id,
    prompt: 'a cat',
    negativePrompt: undefined,
    aspectRatio: models[0].aspectRatios[0],
    duration: models[0].durations[0],
    seed: undefined,
    image: undefined,
    lora: undefined,
  });
});

test('rejects bad input', () => {
  const v = (body) => validateGenerateRequest(body, models).error;
  assert.match(v({}), /prompt is required/);
  assert.match(v({ prompt: 'x'.repeat(2001) }), /at most/);
  assert.match(v({ prompt: 'x', model: 'nope' }), /model must be one of/);
  assert.match(v({ prompt: 'x', aspectRatio: '4:3' }), /aspect ratios/);
  assert.match(v({ prompt: 'x', duration: 7 }), /durations/);
  assert.match(v({ prompt: 'x', seed: -1 }), /seed/);
  assert.match(v({ prompt: 'x', image: 'https://example.com/a.png' }), /image/);
  assert.match(v(null), /JSON object/);
});

test('enforces per-model limits', () => {
  const fast = [byId('wan-2.2-fast')];
  assert.match(validateGenerateRequest({ prompt: 'x', aspectRatio: '1:1' }, fast).error, /16:9, 9:16/);
  assert.match(validateGenerateRequest({ prompt: 'x', duration: 10 }, fast).error, /5 seconds/);
  assert.match(validateGenerateRequest({ prompt: 'x', lora: { path: 'a/b' } }, fast).error, /does not support LoRAs/);
});

test('accepts an image data URL and a LoRA', () => {
  const image = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
  const { value } = validateGenerateRequest(
    { prompt: 'x', model: 'wan-2.2-a14b', image, lora: { path: 'https://hf.co/me/style.safetensors', scale: 0.7 } },
    models,
  );
  assert.equal(value.image, image);
  assert.deepEqual(value.lora, { path: 'https://hf.co/me/style.safetensors', scale: 0.7 });

  const hf = validateGenerateRequest({ prompt: 'x', model: 'ltx-2-local', lora: { path: 'me/style/w.safetensors' } }, models);
  assert.deepEqual(hf.value.lora, { path: 'me/style/w.safetensors', scale: 1 });

  const v = (lora) => validateGenerateRequest({ prompt: 'x', model: 'wan-2.2-a14b', lora }, models).error;
  assert.match(v({ path: 'http://insecure/x.safetensors' }), /lora.path/);
  assert.match(v({ path: '/etc/passwd' }), /lora.path/);
  assert.match(v({ path: 'a/b', scale: 3 }), /lora.scale/);
});
