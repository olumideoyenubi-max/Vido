// Self-hosted backend: talks to the Python GPU worker in worker/ (or anything
// that implements the same three routes).
//   POST /jobs            { model, prompt, ... } -> { id, status }
//   GET  /jobs/:id        -> { status, progress, error }
//   GET  /jobs/:id/video  -> video/mp4

export function createLocalProvider({ url, token, fetchImpl = fetch }) {
  if (!url) throw new Error('LOCAL_WORKER_URL is required for the local backend');
  const base = url.replace(/\/+$/, '');
  const auth = token ? { Authorization: `Bearer ${token}` } : {};

  async function call(path, init = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...auth, ...init.headers },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Worker ${res.status}: ${body.error ?? res.statusText}`);
    return body;
  }

  return {
    name: 'local',

    async submit({ endpoint, input }) {
      const job = await call('/jobs', { method: 'POST', body: JSON.stringify({ model: endpoint, ...input }) });
      return { externalId: job.id, status: job.status ?? 'queued' };
    },

    async poll(externalId) {
      const id = encodeURIComponent(externalId);
      const job = await call(`/jobs/${id}`);
      if (job.status === 'succeeded') {
        // The worker is usually not reachable from the browser, so hand the
        // media store a URL (plus credentials) to copy the file from.
        return { status: 'succeeded', output: { url: `${base}/jobs/${id}/video`, mimeType: 'video/mp4', headers: auth } };
      }
      if (job.status === 'failed') return { status: 'failed', error: job.error ?? 'Worker job failed' };
      return { status: job.status === 'running' ? 'running' : 'queued', progress: job.progress };
    },
  };
}
