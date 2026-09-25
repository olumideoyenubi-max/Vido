// Replicate provider — https://replicate.com/docs/reference/http
// Works with any video model that accepts a `prompt` input; other inputs are
// only sent when set, since input names vary from model to model.

const API = 'https://api.replicate.com/v1';

const STATUS = {
  starting: 'queued',
  processing: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'failed',
};

export function createReplicateProvider({ token, model, fetchImpl = fetch }) {
  if (!token) throw new Error('REPLICATE_API_TOKEN is required for the replicate provider');
  if (!model) throw new Error('REPLICATE_MODEL is required for the replicate provider');

  async function call(path, init = {}) {
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Replicate ${res.status}: ${body.detail ?? body.title ?? res.statusText}`);
    return body;
  }

  function translate(prediction) {
    const result = { status: STATUS[prediction.status] ?? 'running' };
    if (prediction.status === 'succeeded') {
      const url = Array.isArray(prediction.output) ? prediction.output.at(-1) : prediction.output;
      if (typeof url !== 'string') return { status: 'failed', error: 'Model returned no video URL' };
      result.output = { url, mimeType: 'video/mp4' };
    }
    if (result.status === 'failed') result.error = prediction.error ?? `Prediction ${prediction.status}`;
    return result;
  }

  return {
    name: 'replicate',
    model,
    supportsImage: true,

    async submit({ prompt, negativePrompt, aspectRatio, duration, seed, image }) {
      const input = { prompt };
      if (negativePrompt) input.negative_prompt = negativePrompt;
      if (aspectRatio) input.aspect_ratio = aspectRatio;
      if (duration) input.duration = duration;
      if (seed != null) input.seed = seed;
      if (image) {
        input.image = image;
        input.first_frame_image = image;
      }
      const path = model.includes(':')
        ? '/predictions'
        : `/models/${model}/predictions`;
      const payload = model.includes(':') ? { version: model.split(':')[1], input } : { input };
      const prediction = await call(path, { method: 'POST', body: JSON.stringify(payload) });
      return { externalId: prediction.id, ...translate(prediction) };
    },

    async poll(externalId) {
      return translate(await call(`/predictions/${encodeURIComponent(externalId)}`));
    },
  };
}
