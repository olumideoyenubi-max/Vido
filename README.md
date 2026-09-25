# Vido — AI Video Generator

Turn a text prompt, and optionally a start image, into a short video clip. Vido is a small web app with no dependencies. It sends generation jobs to a hosted video model, tracks them until they finish, and keeps a gallery of your results.

- **Text-to-video and image-to-video.** Describe a scene, or drop in a still image to animate it.
- **Style presets.** Cinematic, Anime, 3D render, Documentary, Stop motion and Drone.
- **Controls.** Aspect ratio (16:9, 9:16, 1:1), duration (5s or 10s), a negative prompt and a seed.
- **Background jobs.** The server polls the provider for you. History is saved to `data/jobs.json`, and in-progress jobs pick up again after a restart.
- **Pluggable providers:** `mock` (offline, no key), [Replicate](https://replicate.com) and [fal.ai](https://fal.ai).

## Quick start

Requires Node.js 22 or later. There is nothing to install.

```bash
cp .env.example .env   # optional; defaults to the offline mock provider
npm start              # http://localhost:3000
```

The `mock` provider doesn't call a real model. It simulates a render and returns an animated preview built from your prompt, so you can try the whole flow without an API key.

## Using a real video model

Edit `.env`:

```bash
# Replicate
VIDEO_PROVIDER=replicate
REPLICATE_API_TOKEN=r8_...
REPLICATE_MODEL=minimax/video-01        # or owner/name:version

# fal.ai
VIDEO_PROVIDER=fal
FAL_KEY=...
FAL_MODEL=fal-ai/kling-video/v2.1/standard/text-to-video
FAL_IMAGE_MODEL=fal-ai/kling-video/v2.1/standard/image-to-video
```

Vido always sends `prompt`. It sends `aspect_ratio`, `duration`, `negative_prompt`, `seed` and the image (`image`/`first_frame_image` on Replicate, `image_url` on fal) only when they are set. Input names differ between models, so check the model's page if a setting seems to be ignored.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/config` | Active provider, model and allowed options |
| `POST` | `/api/generate` | `{ prompt, aspectRatio?, duration?, negativePrompt?, seed?, image? }` → `202` with a job |
| `GET` | `/api/jobs` | All jobs, newest first |
| `GET` | `/api/jobs/:id` | One job: `status` is `queued`, `running`, `succeeded` or `failed`; `output.url` is set when done |
| `DELETE` | `/api/jobs/:id` | Remove a job from history |

`image` must be a base64 data URL (PNG, JPEG, WebP or GIF, up to 8 MB).

## Project layout

```
src/server.js        HTTP server, API routes, static files
src/jobs.js          Job store: submit, poll, persist
src/validate.js      Request validation
src/providers/       mock, replicate, fal adapters (submit + poll)
public/              Front end (vanilla HTML/CSS/JS)
test/                node:test suites
```

To add a provider, create an object with `name`, `supportsImage`, `submit(request) → { externalId, status }` and `poll(externalId) → { status, progress?, output?, error? }`, then register it in `src/providers/index.js`.

## Tests

```bash
npm test
```
