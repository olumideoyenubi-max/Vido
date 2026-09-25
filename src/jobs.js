import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const TERMINAL = new Set(['succeeded', 'failed']);

// Tracks generation jobs, polls the provider until each one finishes, and
// persists history to a JSON file so the gallery survives restarts.
export class JobStore {
  constructor({ provider, file, pollIntervalMs = 3000, maxJobs = 200 }) {
    this.provider = provider;
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

  async create(request) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      provider: this.provider.name,
      model: this.provider.model ?? null,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt ?? null,
      aspectRatio: request.aspectRatio,
      duration: request.duration,
      seed: request.seed ?? null,
      hasImage: Boolean(request.image),
      status: 'queued',
      progress: 0,
      output: null,
      error: null,
      externalId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.#trim();

    try {
      const result = await this.provider.submit(request);
      job.externalId = result.externalId;
      this.#apply(job, result);
    } catch (err) {
      this.#apply(job, { status: 'failed', error: err.message });
    }
    if (!TERMINAL.has(job.status)) this.#schedule(job.id, this.pollIntervalMs);
    this.#save();
    return publicView(job);
  }

  delete(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const existed = this.jobs.delete(id);
    if (existed) this.#save();
    return existed;
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    return this.saving;
  }

  async #poll(id) {
    this.timers.delete(id);
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return;
    if (!job.externalId) {
      this.#apply(job, { status: 'failed', error: 'Job was interrupted before it reached the provider' });
    } else {
      try {
        this.#apply(job, await this.provider.poll(job.externalId));
        job.pollFailures = 0;
      } catch (err) {
        job.pollFailures = (job.pollFailures ?? 0) + 1;
        if (job.pollFailures >= 5) this.#apply(job, { status: 'failed', error: err.message });
      }
    }
    if (!TERMINAL.has(job.status) && this.jobs.has(id)) this.#schedule(id, this.pollIntervalMs);
    this.#save();
  }

  #schedule(id, delay) {
    const timer = setTimeout(() => this.#poll(id), delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  #apply(job, { status, progress, output, error }) {
    if (status) job.status = status;
    if (progress != null) job.progress = progress;
    if (status === 'succeeded') job.progress = 1;
    if (output) job.output = output;
    if (error) job.error = error;
    job.updatedAt = new Date().toISOString();
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
