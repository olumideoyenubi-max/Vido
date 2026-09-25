// Catalog of open-weight video models Vido can run, and how each one maps a
// Vido request onto its backend's inputs. A model only shows up in the app
// when its backend is configured (see src/providers/index.js).
//
// Every request passed to endpoint()/input() has already been validated:
// { prompt, negativePrompt?, aspectRatio, duration, seed?, image?, lora? }
// where lora is { path, scale }.

const FAL_WAN = 'fal-ai/wan/v2.2-a14b';
const WAN_FPS = 16;

export const MODELS = [
  {
    id: 'wan-2.2-a14b',
    name: 'Wan 2.2 A14B',
    backend: 'fal',
    license: 'Apache-2.0',
    description: "Alibaba's flagship open model: strong motion and prompt following, 720p. Supports LoRAs.",
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10],
    supportsImage: true,
    supportsLora: true,
    endpoint: ({ image, lora }) => `${FAL_WAN}/${image ? 'image-to-video' : 'text-to-video'}${lora ? '/lora' : ''}`,
    input: (req) =>
      compact({
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        image_url: req.image,
        // Image-to-video follows the image's own framing.
        aspect_ratio: req.image ? 'auto' : req.aspectRatio,
        resolution: '720p',
        frames_per_second: WAN_FPS,
        // 5s -> 81 frames, 10s -> 161 (the endpoint's maximum).
        num_frames: req.duration * WAN_FPS + 1,
        seed: req.seed,
        loras: req.lora && [{ path: req.lora.path, scale: req.lora.scale }],
      }),
  },
  {
    id: 'wan-2.2-fast',
    name: 'Wan 2.2 Fast',
    backend: 'replicate',
    license: 'Apache-2.0',
    description: 'Speed-optimized Wan 2.2 on Replicate: about 40s for a 5s clip at 480p. Cheapest option.',
    aspectRatios: ['16:9', '9:16'],
    durations: [5],
    supportsImage: true,
    supportsLora: false,
    endpoint: ({ image }) => (image ? 'wan-video/wan-2.2-i2v-fast' : 'wan-video/wan-2.2-t2v-fast'),
    input: (req) =>
      compact({
        prompt: req.prompt,
        image: req.image,
        aspect_ratio: req.image ? undefined : req.aspectRatio,
        resolution: '480p',
        num_frames: 81,
        frames_per_second: WAN_FPS,
        seed: req.seed,
      }),
  },
  {
    id: 'wan-2.2-5b-local',
    name: 'Wan 2.2 TI2V 5B (self-hosted)',
    backend: 'local',
    license: 'Apache-2.0',
    description: 'Runs on your own GPU (24 GB+). 720p at 24 fps, text or image to video. Supports LoRAs.',
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5],
    supportsImage: true,
    supportsLora: true,
    endpoint: () => 'wan-2.2-5b',
    input: localInput,
  },
  {
    id: 'ltx-2-local',
    name: 'LTX-2 (self-hosted)',
    backend: 'local',
    license: 'LTX-2 Community License',
    description: 'Lightricks LTX-2 on your own GPU: fast, with generated audio. Supports LoRAs.',
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10],
    supportsImage: true,
    supportsLora: true,
    endpoint: () => 'ltx-2',
    input: localInput,
  },
  {
    id: 'mock',
    name: 'Mock preview',
    backend: 'mock',
    license: 'n/a',
    description: 'No real model. Returns an animated preview instantly so you can try the app without a key.',
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10],
    supportsImage: true,
    supportsLora: true,
    endpoint: () => 'mock',
    input: (req) => ({ prompt: req.prompt, aspectRatio: req.aspectRatio, duration: req.duration }),
  },
];

// The self-hosted worker takes Vido's own field names; it picks resolution
// and frame counts per model itself.
function localInput(req) {
  return compact({
    prompt: req.prompt,
    negative_prompt: req.negativePrompt,
    aspect_ratio: req.aspectRatio,
    duration: req.duration,
    seed: req.seed,
    image: req.image,
    lora: req.lora,
  });
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

// Fields the browser needs to build the form.
export function publicModel({ endpoint, input, ...model }) {
  return model;
}
