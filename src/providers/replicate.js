// Replicate backend — https://replicate.com/docs/reference/http
// `endpoint` is a model reference: "owner/name" or "owner/name:version".

const API = 'https://api.replicate.com/v1';

const STATUS = {
  starting: 'queued',
  processing: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'failed',
};

export function createReplicateProvider({ token, fetchImpl = fetch }) {
  if (!token) throw new Error('REPLICATE_API_TOKEN is required for the replicate backend');

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

    async submit({ endpoint, input }) {
      const [model, version] = endpoint.split(':');
      const prediction = version
        ? await call('/predictions', { method: 'POST', body: JSON.stringify({ version, input }) })
        : await call(`/models/${model}/predictions`, { method: 'POST', body: JSON.stringify({ input }) });
      return { externalId: prediction.id, ...translate(prediction) };
    },

    async poll(externalId) {
      return translate(await call(`/predictions/${encodeURIComponent(externalId)}`));
    },
  };
}
