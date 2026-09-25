# Vido — AI Video Generator

Turn a text prompt, and optionally a start image, into a short video clip using **open-weight video models**. Run them through a hosted API, or on your own GPU.

- **Open models:** Wan 2.2 (Alibaba, Apache-2.0) and LTX-2 (Lightricks), with a model picker in the UI.
- **Hosted or self-hosted:** use [fal.ai](https://fal.ai) or [Replicate](https://replicate.com) with just an API key, or run the models on your own GPU with the included Python worker.
- **LoRAs:** plug in your own fine-tuned style or character. See [Fine-tuning your own style](#fine-tuning-your-own-style).
- **Text-to-video and image-to-video**, plus style presets, aspect ratio, duration, negative prompt and seed.
- **Your videos stay put.** Finished clips are copied to `data/media/` and served from there. Provider links expire (Replicate deletes outputs after about an hour), but these don't.

## Models

| Model | Runs on | Image → video | LoRA | Lengths | Notes |
| --- | --- | --- | --- | --- | --- |
| Wan 2.2 A14B | fal (`FAL_KEY`) | ✓ | ✓ | 5s, 10s | Best quality of the open models, 720p |
| Wan 2.2 Fast | Replicate (`REPLICATE_API_TOKEN`) | ✓ | — | 5s | Cheapest and fastest, 480p |
| Wan 2.2 TI2V 5B | Your GPU (`LOCAL_WORKER_URL`) | ✓ | ✓ | 5s | 720p at 24 fps; 24 GB+ VRAM |
| LTX-2 | Your GPU (`LOCAL_WORKER_URL`) | ✓ | ✓ | 5s, 10s | Fast, and generates audio too |
| Mock preview | Built in | ✓ | ✓ | 5s, 10s | No model; for trying the app |

The app shows only the models whose backend is configured. To add a model or change its settings (resolution, frame rate), edit `src/models.js`. Each entry says which backend it uses and how to translate a request into that model's inputs.

## Quick start

Requires Node.js 22 or later. There is nothing to install.

```bash
cp .env.example .env   # add FAL_KEY and/or REPLICATE_API_TOKEN, or leave empty for the mock
npm start              # http://localhost:3000
```

## Running models on your own GPU

The `worker/` folder is a small Python service that runs Wan 2.2 TI2V 5B and LTX-2 with Hugging Face [diffusers](https://github.com/huggingface/diffusers). Vido sends it jobs and copies back the finished videos.

**Requirements:** an NVIDIA GPU with 24 GB+ VRAM (for example an RTX 4090, L4/L40S or A100), Python 3.10+, and roughly 50 GB of disk for the model weights. If you don't own one, a rented cloud GPU from RunPod, Lambda, Vast.ai or Modal works.

```bash
cd worker
python -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu124   # match your CUDA version
pip install -r requirements.txt

WORKER_TOKEN=pick-a-secret python server.py --host 0.0.0.0 --port 8188 --preload wan-2.2-5b
```

Then in Vido's `.env`:

```bash
LOCAL_WORKER_URL=http://<gpu-machine>:8188
LOCAL_WORKER_TOKEN=pick-a-secret
```

**Notes**
- The first job for each model downloads its weights from Hugging Face. `--preload` does this at startup instead.
- Only one model is held in GPU memory at a time. Switching between Wan and LTX-2 reloads, which takes a minute or two.
- CPU offload is on by default, so the models fit in 24 GB. On an 80 GB card, set `WORKER_CPU_OFFLOAD=0` for faster generation.
- Always set `WORKER_TOKEN` when the worker is reachable from other machines.

## Fine-tuning your own style

A general model is hard to beat at everything. A LoRA trained on your own footage can beat it at one thing: a visual style, a product or a character. The steps:

1. **Collect** 50–200 short clips (2–5 s) of exactly the look you want. Only use footage you own or have rights to.
2. **Caption** each clip with a detailed description, and include a trigger word such as `in vidostyle`.
3. **Train** a LoRA for the base model you'll run:
   - *Hosted, no setup:* fal's Wan trainers (search for "wan trainer" on fal.ai). Upload a zip of clips and captions and you get back a `.safetensors` URL.
   - *Self-managed:* [diffusion-pipe](https://github.com/tdrussell/diffusion-pipe) or [musubi-tuner](https://github.com/kohya-ss/musubi-tuner) on a rented A100/H100. Training takes a few hours.
4. **Use it:** in Vido, open **Advanced → LoRA** and paste either the `.safetensors` https URL or a Hugging Face id (`owner/repo` or `owner/repo/file.safetensors`). Put the trigger word in your prompt.

A LoRA only works with the model family it was trained on. Wan 2.2 LoRAs work with the Wan models, and LTX-2 LoRAs work with LTX-2.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/config` | Available models and their options |
| `POST` | `/api/generate` | `{ model?, prompt, aspectRatio?, duration?, negativePrompt?, seed?, image?, lora? }` → `202` with a job |
| `GET` | `/api/jobs` | All jobs, newest first |
| `GET` | `/api/jobs/:id` | One job: `status` is `queued`, `running`, `succeeded` or `failed`; `output.url` is set when done |
| `DELETE` | `/api/jobs/:id` | Remove a job and its video |
| `GET` | `/media/:file` | Saved videos (supports Range requests) |

`image` is a base64 data URL (PNG, JPEG, WebP or GIF, up to 8 MB). `lora` is `{ path, scale }`, where `scale` is between 0 and 2.

## Project layout

```
src/server.js        HTTP server, API routes, static files
src/models.js        Model catalog: which backend, and how to map inputs
src/jobs.js          Job store: submit, poll, save output, persist history
src/media.js         Downloads finished videos and serves them
src/validate.js      Request validation (per model)
src/providers/       Backends: fal, replicate, local (GPU worker), mock
worker/              Python GPU worker (diffusers) for self-hosting
public/              Front end (vanilla HTML/CSS/JS)
test/                Node tests
```

## Tests

```bash
npm test                                   # app
python3 -m unittest worker/test_server.py  # worker API; no GPU needed
```
