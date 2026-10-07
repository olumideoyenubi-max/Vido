import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const ACTIVE = new Set(['queued', 'running']);

// Tracks generation jobs, polls each model's backend until the job finishes,
// copies the result into the media store, and persists history to a JSON
// file so the gallery survives restarts.
export class JobStore {
  constructor({ backends, models, media, file, pollIntervalMs = 3000, maxJobs = 200 }) {
    this.backends = backends;
    this.models = new Map(models.map((m) => [m.id, m]));
    this.media = media;
    this.file = file;
    this.pollIntervalMs = pollIntervalMs;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
    this.timers = new Map();
    this.saving = Promise.resolve();
  }

  async load() {
    if (!this.file) return;
    let saved;
    try {
      saved = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const job of saved) {
      this.jobs.set(job.id, job);
      if (!TERMINAL.has(job.status)) this.#schedule(job.id, 0);
    }
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicView);
  }

  get(id) {
    const job = this.jobs.get(id);
    return job && publicView(job);
  }

  // `request` must already be validated against the model.
  async create(request) {
    const model = this.models.get(request.model);
    if (!model) throw new Error(`Unknown model ${request.model}`);
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      model: model.id,
      modelName: model.name,
      backend: model.backend,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt ?? null,
      aspectRatio: request.aspectRatio,
      duration: request.duration,
      seed: request.seed ?? null,
      lora: request.lora ?? null,
      hasImage: Boolean(request.image),
      status: 'queued',
      progress: 0,
      progressEstimated: false,
      startedAt: null,
      output: null,
      error: null,
      externalId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.#trim();

    try {
      const backend = this.#backend(job);
      const result = await backend.submit({ endpoint: model.endpoint(request), input: model.input(request) });
      job.externalId = result.externalId;
      // Canceled (or deleted) while the submit was in flight.
      if (job.status === 'canceled' || !this.jobs.has(job.id)) {
        this.#cancelRemote(job);
        return publicView(job);
      }
      await this.#settle(job, result);
    } catch (err) {
      this.#apply(job, { status: 'failed', error: err.message });
    }
    if (!TERMINAL.has(job.status)) this.#schedule(job.id, this.pollIntervalMs);
    this.#save();
    return publicView(job);
  }

  // Stops a queued or running job and asks its backend to stop too, so it
  // isn't left running (and billing). Returns the job, or undefined.
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (ACTIVE.has(job.status)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.#apply(job, { status: 'canceled' });
      this.#cancelRemote(job);
      this.#save();
    }
    return publicView(job);
  }

  delete(id) {
    this.cancel(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const existed = this.jobs.delete(id);
    if (existed) {
      this.media?.remove(id);
      this.#save();
    }
    return existed;
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    return this.saving;
  }

  // Best effort: the job is already canceled here whatever the backend says.
  // Without an externalId the submit is still in flight; create() calls this
  // again once it returns.
  #cancelRemote(job) {
    const backend = this.backends[job.backend];
    if (!job.externalId || !backend?.cancel) return;
    backend.cancel(job.externalId).catch((err) => console.warn(`Could not cancel job ${job.id} on ${job.backend}: ${err.message}`));
  }

  #backend(job) {
    const backend = this.backends[job.backend];
    if (!backend) throw new Error(`The ${job.backend} backend is not configured on this server`);
    return backend;
  }

  async #poll(id) {
    this.timers.delete(id);
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return;
    if (!job.externalId) {
      this.#apply(job, { status: 'failed', error: 'Job was interrupted before it reached the backend' });
    } else {
      try {
        const result = await this.#backend(job).poll(job.externalId);
        // Canceled while the poll was in flight: keep it canceled.
        if (TERMINAL.has(job.status)) return;
        await this.#settle(job, result);
        job.pollFailures = 0;
      } catch (err) {
        job.pollFailures = (job.pollFailures ?? 0) + 1;
        if (job.pollFailures >= 5 || !this.backends[job.backend]) this.#apply(job, { status: 'failed', error: err.message });
      }
    }
    if (!TERMINAL.has(job.status) && this.jobs.has(id)) this.#schedule(id, this.pollIntervalMs);
    this.#save();
  }

  // Applies a backend result; on success, copies the video locally first so
  // the job is only marked done once it has a URL that won't expire.
  async #settle(job, result) {
    if (result.status !== 'succeeded' || !result.output) return this.#apply(job, result);
    const { headers, ...remote } = result.output;
    let output = remote;
    if (this.media) {
      try {
        output = await this.media.save(job.id, result.output);
      } catch (err) {
        // Without credentials the remote link still works for a while; with
        // them (a private worker) the browser couldn't load it at all.
        if (headers && Object.keys(headers).length) {
          return this.#apply(job, { status: 'failed', error: `Could not save the video: ${err.message}` });
        }
        console.warn(`Could not save video for job ${job.id}, keeping the provider link: ${err.message}`);
      }
    }
    if (!this.jobs.has(job.id) || job.status === 'canceled') {
      this.media?.remove(job.id);
      return;
    }
    this.#apply(job, { ...result, output });
  }

  #schedule(id, delay) {
    const timer = setTimeout(() => this.#poll(id), delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  #apply(job, { status, progress, output, error }) {
    const now = new Date();
    if (status) job.status = status;
    if (status === 'running' && !job.startedAt) job.startedAt = now.toISOString();
    if (progress != null) {
      job.progress = progress;
      job.progressEstimated = false;
    } else if (status === 'running') {
      this.#estimateProgress(job, now);
    }
    if (status === 'succeeded') {
      job.progress = 1;
      job.progressEstimated = false;
    }
    if (output) job.output = output;
    if (error) job.error = error;
    job.updatedAt = now.toISOString();
  }

  // fal and Replicate don't report progress, so estimate it from how long
  // this model usually takes. Capped below 100% since it's only a guess.
  #estimateProgress(job, now) {
    const typical = this.models.get(job.model)?.typicalSeconds;
    if (!typical) return;
    const elapsed = (now - new Date(job.startedAt)) / 1000;
    job.progress = Math.min(0.95, elapsed / (typical * (job.duration / 5)));
    job.progressEstimated = true;
  }

  #trim() {
    const excess = this.jobs.size - this.maxJobs;
    if (excess <= 0) return;
    const oldest = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of oldest.slice(0, excess)) this.delete(job.id);
  }

  #save() {
    if (!this.file) return;
    const snapshot = JSON.stringify([...this.jobs.values()], null, 2);
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot);
        await rename(tmp, this.file);
      })
      .catch((err) => console.error('Failed to save job history:', err.message));
  }
}

function publicView({ externalId, pollFailures, ...job }) {
  return job;
}
