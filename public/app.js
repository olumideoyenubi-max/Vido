const STYLES = {
  None: '',
  Cinematic: 'cinematic lighting, shallow depth of field, 35mm film, dramatic composition',
  Anime: 'anime style, vibrant colors, cel shading, detailed backgrounds',
  '3D render': 'high quality 3D render, soft global illumination, octane render',
  Documentary: 'handheld documentary footage, natural light, realistic',
  'Stop motion': 'claymation stop-motion animation, tactile textures',
  Drone: 'aerial drone shot, sweeping camera movement, wide establishing view',
};

const $ = (id) => document.getElementById(id);
const form = $('generate-form');
const promptEl = $('prompt');
const gallery = $('gallery');
const template = $('card-template');

const state = {
  config: null,
  aspectRatio: '16:9',
  duration: 5,
  style: 'None',
  image: null,
  jobs: [],
  pollTimer: null,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function segmented(container, options, current, format, onChange) {
  container.replaceChildren(
    ...options.map((value) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = format(value);
      btn.setAttribute('aria-pressed', String(value === current));
      btn.addEventListener('click', () => {
        for (const b of container.children) b.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-pressed', 'true');
        onChange(value);
      });
      return btn;
    }),
  );
}

function setupForm(config) {
  segmented($('aspect-ratios'), config.aspectRatios, state.aspectRatio, (v) => v, (v) => (state.aspectRatio = v));
  segmented($('durations'), config.durations, state.duration, (v) => `${v}s`, (v) => (state.duration = v));
  segmented($('styles'), Object.keys(STYLES), state.style, (v) => v, (v) => (state.style = v));

  promptEl.maxLength = config.maxPromptLength;
  const updateCount = () => ($('prompt-count').textContent = `${promptEl.value.length} / ${config.maxPromptLength}`);
  promptEl.addEventListener('input', updateCount);
  updateCount();

  $('image-field').hidden = !config.supportsImage;

  const badge = $('provider-badge');
  badge.textContent = config.model ? `${config.provider} · ${config.model}` : config.provider;
  badge.hidden = false;
}

// --- Start image ---------------------------------------------------------

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function setImage(dataUrl) {
  state.image = dataUrl;
  const preview = $('image-preview');
  preview.hidden = !dataUrl;
  if (dataUrl) preview.src = dataUrl;
  else preview.removeAttribute('src');
  $('dropzone-text').hidden = Boolean(dataUrl);
  $('clear-image').hidden = !dataUrl;
  if (!dataUrl) $('image').value = '';
}

function loadImage(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return showFormError('Use a PNG, JPEG, WebP or GIF image.');
  if (file.size > MAX_IMAGE_BYTES) return showFormError('Image must be 8 MB or smaller.');
  const reader = new FileReader();
  reader.onload = () => setImage(reader.result);
  reader.readAsDataURL(file);
}

$('image').addEventListener('change', (e) => loadImage(e.target.files[0]));
$('clear-image').addEventListener('click', () => setImage(null));
const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  loadImage(e.dataTransfer.files[0]);
});

// --- Submit --------------------------------------------------------------

function showFormError(message) {
  const el = $('form-error');
  el.textContent = message ?? '';
  el.hidden = !message;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showFormError(null);
  const base = promptEl.value.trim();
  if (!base) return showFormError('Describe the video you want to create.');

  const styleText = STYLES[state.style];
  const body = {
    prompt: styleText ? `${base}, ${styleText}` : base,
    aspectRatio: state.aspectRatio,
    duration: state.duration,
    negativePrompt: $('negative-prompt').value.trim() || undefined,
    seed: $('seed').value === '' ? undefined : Number($('seed').value),
    image: state.image ?? undefined,
  };

  const submit = $('submit');
  submit.disabled = true;
  submit.textContent = 'Submitting…';
  try {
    const job = await api('/api/generate', { method: 'POST', body: JSON.stringify(body) });
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    render();
    schedulePoll();
  } catch (err) {
    showFormError(err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Generate video';
  }
});

// --- Gallery -------------------------------------------------------------

const ACTIVE = new Set(['queued', 'running']);
const cards = new Map();

function safeMediaUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
    if (parsed.protocol === 'data:' && /^data:(image|video)\//.test(url)) return url;
  } catch {}
  return null;
}

function renderMedia(container, job) {
  const key = `${job.status}:${job.output?.url ?? ''}`;
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  container.style.aspectRatio = job.aspectRatio.replace(':', ' / ');

  const url = job.output && safeMediaUrl(job.output.url);
  if (job.status === 'succeeded' && url) {
    let el;
    if (job.output.mimeType?.startsWith('image/')) {
      el = document.createElement('img');
      el.alt = job.prompt;
    } else {
      el = document.createElement('video');
      el.controls = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = 'metadata';
    }
    el.src = url;
    container.replaceChildren(el);
  } else if (ACTIVE.has(job.status)) {
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-label', 'Generating');
    container.replaceChildren(spinner);
  } else {
    container.replaceChildren();
  }
}

function describe(job) {
  const status = { queued: 'Queued', running: 'Generating', succeeded: 'Ready', failed: 'Failed' }[job.status] ?? job.status;
  const when = new Date(job.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const parts = [status, job.aspectRatio, `${job.duration}s`];
  if (job.hasImage) parts.push('from image');
  parts.push(when);
  return parts.join(' · ');
}

function renderCard(job) {
  let card = cards.get(job.id);
  if (!card) {
    card = template.content.firstElementChild.cloneNode(true);
    card.querySelector('.reuse').addEventListener('click', () => {
      promptEl.value = card.dataset.prompt;
      promptEl.dispatchEvent(new Event('input'));
      promptEl.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    card.querySelector('.delete').addEventListener('click', async () => {
      try {
        await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
      } catch (err) {
        if (!/not found/i.test(err.message)) return alert(err.message);
      }
      state.jobs = state.jobs.filter((j) => j.id !== job.id);
      render();
    });
    cards.set(job.id, card);
  }

  card.dataset.prompt = job.prompt;
  card.querySelector('.prompt').textContent = job.prompt;
  card.querySelector('.meta').textContent = describe(job);
  renderMedia(card.querySelector('.media'), job);

  const progress = card.querySelector('.progress');
  progress.hidden = !ACTIVE.has(job.status);
  progress.querySelector('.bar').style.width = `${Math.round((job.progress || 0.03) * 100)}%`;

  const error = card.querySelector('.error');
  error.hidden = !job.error;
  error.textContent = job.error ?? '';

  const download = card.querySelector('.download');
  const url = job.status === 'succeeded' && job.output && safeMediaUrl(job.output.url);
  download.hidden = !url;
  if (url) {
    download.href = url;
    download.download = `vido-${job.id.slice(0, 8)}.${job.output.mimeType === 'image/svg+xml' ? 'svg' : 'mp4'}`;
  }
  return card;
}

function render() {
  const ids = new Set(state.jobs.map((j) => j.id));
  for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);
  gallery.replaceChildren(...state.jobs.map(renderCard));
  $('empty').hidden = state.jobs.length > 0;
}

async function refresh() {
  try {
    state.jobs = await api('/api/jobs');
    render();
  } catch (err) {
    console.warn('Could not refresh jobs:', err.message);
  }
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (state.jobs.some((j) => ACTIVE.has(j.status))) state.pollTimer = setTimeout(refresh, 2000);
}

// --- Boot ----------------------------------------------------------------

(async () => {
  try {
    state.config = await api('/api/config');
    setupForm(state.config);
  } catch (err) {
    showFormError(`Could not reach the server: ${err.message}`);
    return;
  }
  await refresh();
})();
