import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGenerateRequest } from '../src/validate.js';

test('accepts a minimal prompt and applies defaults', () => {
  const { value, error } = validateGenerateRequest({ prompt: '  a cat  ' });
  assert.equal(error, undefined);
  assert.deepEqual(value, { prompt: 'a cat', negativePrompt: undefined, aspectRatio: '16:9', duration: 5, seed: undefined, image: undefined });
});

test('rejects bad input', () => {
  assert.match(validateGenerateRequest({}).error, /prompt is required/);
  assert.match(validateGenerateRequest({ prompt: 'x'.repeat(2001) }).error, /at most/);
  assert.match(validateGenerateRequest({ prompt: 'x', aspectRatio: '4:3' }).error, /aspectRatio/);
  assert.match(validateGenerateRequest({ prompt: 'x', duration: 7 }).error, /duration/);
  assert.match(validateGenerateRequest({ prompt: 'x', seed: -1 }).error, /seed/);
  assert.match(validateGenerateRequest({ prompt: 'x', image: 'https://example.com/a.png' }).error, /image/);
  assert.match(validateGenerateRequest(null).error, /JSON object/);
});

test('accepts an image data URL', () => {
  const image = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
  assert.equal(validateGenerateRequest({ prompt: 'x', image }).value.image, image);
});
