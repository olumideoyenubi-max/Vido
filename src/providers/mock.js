// Offline provider: simulates a generation job and returns an animated SVG
// "clip" built from the prompt. Lets you exercise the full flow with no API key.

const DURATION_MS = 6000;

const DIMENSIONS = {
  '16:9': [640, 360],
  '9:16': [360, 640],
  '1:1': [480, 480],
};

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

function hashHue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

export function renderSvg({ prompt, aspectRatio = '16:9', duration = 5 }) {
  const [w, h] = DIMENSIONS[aspectRatio] ?? DIMENSIONS['16:9'];
  const hue = hashHue(prompt);
  const lines = wrap(prompt, Math.floor(w / 16));
  const lineHeight = 26;
  const top = h / 2 - ((lines.length - 1) * lineHeight) / 2;
  const text = lines
    .map((l, i) => `<text x="50%" y="${top + i * lineHeight}">${escapeXml(l)}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,35%)"><animate attributeName="stop-color" values="hsl(${hue},70%,35%);hsl(${(hue + 120) % 360},70%,35%);hsl(${hue},70%,35%)" dur="${duration}s" repeatCount="indefinite"/></stop>
<stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,20%)"><animate attributeName="stop-color" values="hsl(${(hue + 60) % 360},70%,20%);hsl(${(hue + 240) % 360},70%,20%);hsl(${(hue + 60) % 360},70%,20%)" dur="${duration}s" repeatCount="indefinite"/></stop>
</linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle r="${Math.min(w, h) / 6}" cy="${h / 2}" fill="white" opacity="0.12"><animate attributeName="cx" values="0;${w};0" dur="${duration}s" repeatCount="indefinite"/></circle>
<g font-family="system-ui,sans-serif" font-size="20" fill="white" text-anchor="middle" dominant-baseline="middle">${text}</g>
<text x="12" y="${h - 12}" font-family="monospace" font-size="12" fill="white" opacity="0.6">mock preview · ${escapeXml(aspectRatio)} · ${duration}s</text>
</svg>`;
}

export function createMockProvider({ durationMs = DURATION_MS } = {}) {
  const jobs = new Map();
  let counter = 0;

  return {
    name: 'mock',
    supportsImage: true,

    async submit(request) {
      const externalId = `mock-${Date.now()}-${++counter}`;
      jobs.set(externalId, { request, startedAt: Date.now() });
      return { externalId, status: 'queued' };
    },

    async poll(externalId) {
      const job = jobs.get(externalId);
      if (!job) return { status: 'failed', error: 'Unknown mock job (server restarted?)' };
      const elapsed = Date.now() - job.startedAt;
      if (elapsed < durationMs) {
        return { status: elapsed < durationMs * 0.15 ? 'queued' : 'running', progress: Math.min(0.99, elapsed / durationMs) };
      }
      jobs.delete(externalId);
      const svg = renderSvg(job.request);
      return {
        status: 'succeeded',
        progress: 1,
        output: {
          url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
          mimeType: 'image/svg+xml',
        },
      };
    },
  };
}
