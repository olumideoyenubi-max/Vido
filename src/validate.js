export const MAX_PROMPT_LENGTH = 2000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
// A LoRA is either an https URL to a .safetensors file or a Hugging Face
// repo id, optionally followed by the weights file inside it.
const HF_LORA = /^[\w.-]+\/[\w.-]+(\/[\w./-]+\.safetensors)?$/;

// Returns { value } with a normalized request, or { error } with a message.
// `models` is the list of models available on this server; the first one is
// the default.
export function validateGenerateRequest(body, models) {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object' };

  const model = body.model == null ? models[0] : models.find((m) => m.id === body.model);
  if (!model) return { error: `model must be one of ${models.map((m) => m.id).join(', ')}` };

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return { error: 'prompt is required' };
  if (prompt.length > MAX_PROMPT_LENGTH) return { error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` };

  const aspectRatio = body.aspectRatio ?? model.aspectRatios[0];
  if (!model.aspectRatios.includes(aspectRatio)) {
    return { error: `${model.name} supports aspect ratios ${model.aspectRatios.join(', ')}` };
  }

  const duration = Number(body.duration ?? model.durations[0]);
  if (!model.durations.includes(duration)) {
    return { error: `${model.name} supports durations of ${model.durations.join(' or ')} seconds` };
  }

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
    if (!model.supportsImage) return { error: `${model.name} does not support start images` };
    const match = typeof body.image === 'string' && IMAGE_DATA_URL.exec(body.image);
    if (!match) return { error: 'image must be a base64 PNG, JPEG, WebP or GIF data URL' };
    if (Buffer.byteLength(match[2], 'base64') > MAX_IMAGE_BYTES) return { error: 'image must be 8 MB or smaller' };
    image = body.image;
  }

  let lora;
  if (body.lora != null && body.lora !== '' && body.lora.path) {
    if (!model.supportsLora) return { error: `${model.name} does not support LoRAs` };
    const path = String(body.lora.path).trim();
    if (path.length > 500 || !(isHttpsUrl(path) || HF_LORA.test(path))) {
      return { error: 'lora.path must be an https URL or a Hugging Face repo id like owner/name' };
    }
    const scale = Number(body.lora.scale ?? 1);
    if (!Number.isFinite(scale) || scale < 0 || scale > 2) return { error: 'lora.scale must be between 0 and 2' };
    lora = { path, scale };
  }

  return { value: { model: model.id, prompt, negativePrompt, aspectRatio, duration, seed, image, lora } };
}

function isHttpsUrl(text) {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}
