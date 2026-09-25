export const ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
export const DURATIONS = [5, 10];
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

// Returns { value } with a normalized request, or { error } with a message.
export function validateGenerateRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object' };

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return { error: 'prompt is required' };
  if (prompt.length > MAX_PROMPT_LENGTH) return { error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` };

  const aspectRatio = body.aspectRatio ?? '16:9';
  if (!ASPECT_RATIOS.includes(aspectRatio)) return { error: `aspectRatio must be one of ${ASPECT_RATIOS.join(', ')}` };

  const duration = Number(body.duration ?? 5);
  if (!DURATIONS.includes(duration)) return { error: `duration must be one of ${DURATIONS.join(', ')}` };

  let negativePrompt;
  if (body.negativePrompt != null && body.negativePrompt !== '') {
    if (typeof body.negativePrompt !== 'string') return { error: 'negativePrompt must be a string' };
    negativePrompt = body.negativePrompt.trim().slice(0, MAX_PROMPT_LENGTH) || undefined;
  }

  let seed;
  if (body.seed != null && body.seed !== '') {
    seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 32 - 1) return { error: 'seed must be a non-negative integer' };
  }

  let image;
  if (body.image != null && body.image !== '') {
    const match = typeof body.image === 'string' && IMAGE_DATA_URL.exec(body.image);
    if (!match) return { error: 'image must be a base64 PNG, JPEG, WebP or GIF data URL' };
    if (Buffer.byteLength(match[2], 'base64') > MAX_IMAGE_BYTES) return { error: 'image must be 8 MB or smaller' };
    image = body.image;
  }

  return { value: { prompt, negativePrompt, aspectRatio, duration, seed, image } };
}
