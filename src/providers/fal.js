// fal.ai backend — https://docs.fal.ai/model-apis/model-endpoints/queue
// Uses the async queue API so long renders don't hold a connection open.

const QUEUE = 'https://queue.fal.run';

export function createFalProvider({ key, fetchImpl = fetch }) {
  if (!key) throw new Error('FAL_KEY is required for the fal backend');

  // requestId -> { status_url, response_url } returned by the queue on submit.
  const urls = new Map();

  async function call(url, init = {}) {
    const res = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', ...init.headers },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
      throw new Error(`fal ${res.status}: ${detail}`);
    }
    return body;
  }

  // The status/result URLs are keyed by the app's base path (owner/name),
  // not the full sub-path, so fall back to building them from that.
  function fallbackUrls(endpoint, requestId) {
    const base = endpoint.split('/').slice(0, 2).join('/');
    return {
      status_url: `${QUEUE}/${base}/requests/${requestId}/status`,
      response_url: `${QUEUE}/${base}/requests/${requestId}`,
    };
  }

  return {
    name: 'fal',

    async submit({ endpoint, input }) {
      const queued = await call(`${QUEUE}/${endpoint}`, { method: 'POST', body: JSON.stringify(input) });
      const requestId = queued.request_id;
      const fallback = fallbackUrls(endpoint, requestId);
      urls.set(requestId, {
        status_url: queued.status_url ?? fallback.status_url,
        response_url: queued.response_url ?? fallback.response_url,
      });
      return { externalId: `${endpoint}::${requestId}`, status: 'queued' };
    },

    async poll(externalId) {
      const [endpoint, requestId] = externalId.split('::');
      const { status_url, response_url } = urls.get(requestId) ?? fallbackUrls(endpoint, requestId);
      const status = await call(status_url);
      if (status.status === 'IN_QUEUE') return { status: 'queued' };
      if (status.status === 'IN_PROGRESS') return { status: 'running' };
      if (status.status !== 'COMPLETED') return { status: 'failed', error: `Unexpected fal status ${status.status}` };

      urls.delete(requestId);
      const result = await call(response_url);
      const video = result.video ?? result.videos?.[0];
      if (!video?.url) return { status: 'failed', error: result.detail ?? 'Model returned no video' };
      return { status: 'succeeded', output: { url: video.url, mimeType: video.content_type ?? 'video/mp4' } };
    },
  };
}
