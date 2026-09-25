"""Runs open-weight video models with Hugging Face diffusers.

One model is kept in GPU memory at a time; asking for a different one unloads
the current one first. Text-to-video and image-to-video share weights via
`from_pipe`, so switching between them costs nothing.
"""

import gc
import hashlib
import io
import os
import urllib.request

import torch
from diffusers import (
    AutoencoderKLWan,
    LTX2ImageToVideoPipeline,
    LTX2Pipeline,
    WanImageToVideoPipeline,
    WanPipeline,
)
from diffusers.utils import encode_video, export_to_video
from PIL import Image

WAN_NEGATIVE = (
    "overexposed, static, blurred details, subtitles, worst quality, low quality, JPEG artifacts, ugly, "
    "deformed, disfigured, extra fingers, poorly drawn hands, poorly drawn face, fused fingers, "
    "still picture, messy background, walking backwards"
)
LTX_NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted"

# Sizes are multiples of 32, which both model families require.
MODELS = {
    "wan-2.2-5b": {
        "repo": "Wan-AI/Wan2.2-TI2V-5B-Diffusers",
        "family": "wan",
        "fps": 24,
        "durations": [5],
        "sizes": {"16:9": (1280, 704), "9:16": (704, 1280), "1:1": (960, 960)},
        "steps": 50,
        "guidance": 5.0,
        "negative": WAN_NEGATIVE,
    },
    "ltx-2": {
        "repo": "Lightricks/LTX-2",
        "family": "ltx2",
        "fps": 24,
        "durations": [5, 10],
        "sizes": {"16:9": (960, 544), "9:16": (544, 960), "1:1": (768, 768)},
        "steps": 30,
        "guidance": 3.0,
        "negative": LTX_NEGATIVE,
    },
}

LORA_CACHE = os.environ.get("WORKER_LORA_CACHE", os.path.expanduser("~/.cache/vido/loras"))


def num_frames(spec, duration):
    # Wan wants 4k+1 frames and LTX 8k+1; fps * seconds + 1 satisfies both at 24 fps.
    return spec["fps"] * duration + 1


class DiffusersRunner:
    def __init__(self, device=None, cpu_offload=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        if cpu_offload is None:
            cpu_offload = os.environ.get("WORKER_CPU_OFFLOAD", "1") != "0"
        self.cpu_offload = cpu_offload and self.device == "cuda"
        self.loaded = None
        self.t2v = None
        self.i2v = None
        self.active = None

    def load(self, model_id):
        if self.loaded == model_id:
            return
        self.unload()
        spec = MODELS[model_id]
        print(f"Loading {spec['repo']} (first run downloads the weights)...")
        if spec["family"] == "wan":
            vae = AutoencoderKLWan.from_pretrained(spec["repo"], subfolder="vae", torch_dtype=torch.float32)
            t2v = WanPipeline.from_pretrained(spec["repo"], vae=vae, torch_dtype=torch.bfloat16)
            i2v_cls = WanImageToVideoPipeline
        else:
            t2v = LTX2Pipeline.from_pretrained(spec["repo"], torch_dtype=torch.bfloat16)
            i2v_cls = LTX2ImageToVideoPipeline
        if not self.cpu_offload:
            t2v.to(self.device)
        self.t2v = t2v
        self.i2v = i2v_cls.from_pipe(t2v)
        self.loaded = model_id

    def _activate(self, pipe):
        # Offload hooks live on the shared modules, so (re)install them for
        # whichever pipeline is about to run. Moves each model to the GPU only
        # while it's in use: slower, but Wan 2.2 5B then fits in 24 GB.
        if self.cpu_offload and self.active is not pipe:
            pipe.enable_model_cpu_offload()
        self.active = pipe

    def unload(self):
        self.t2v = self.i2v = self.loaded = self.active = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def generate(self, params, output_path, on_progress):
        spec = MODELS[params["model"]]
        self.load(params["model"])
        pipe = self.i2v if params["image"] else self.t2v
        self._activate(pipe)
        width, height = spec["sizes"][params["aspect_ratio"]]

        steps = spec["steps"]

        def callback(_pipe, step, _timestep, callback_kwargs):
            on_progress((step + 1) / steps)
            return callback_kwargs

        kwargs = {
            "prompt": params["prompt"],
            "negative_prompt": params["negative_prompt"] or spec["negative"],
            "width": width,
            "height": height,
            "num_frames": num_frames(spec, params["duration"]),
            "num_inference_steps": steps,
            "guidance_scale": spec["guidance"],
            "callback_on_step_end": callback,
        }
        if params["seed"] is not None:
            kwargs["generator"] = torch.Generator(device="cpu").manual_seed(params["seed"])
        if params["image"]:
            image = Image.open(io.BytesIO(params["image"])).convert("RGB")
            kwargs["image"] = fit(image, width, height)

        lora = params.get("lora")
        if lora:
            load_lora(pipe, lora["path"], lora["scale"])
        try:
            if spec["family"] == "wan":
                frames = pipe(**kwargs).frames[0]
                export_to_video(frames, output_path, fps=spec["fps"])
            else:
                video, audio = pipe(**kwargs, frame_rate=float(spec["fps"]), output_type="np", return_dict=False)
                encode_video(
                    video[0],
                    fps=spec["fps"],
                    audio=audio[0].float().cpu(),
                    audio_sample_rate=pipe.vocoder.config.output_sampling_rate,
                    output_path=output_path,
                )
        finally:
            if lora:
                pipe.unload_lora_weights()


def fit(image, width, height):
    """Center-crops the image to the target aspect ratio, then resizes it."""
    src_ratio, dst_ratio = image.width / image.height, width / height
    if src_ratio > dst_ratio:
        new_w = round(image.height * dst_ratio)
        left = (image.width - new_w) // 2
        image = image.crop((left, 0, left + new_w, image.height))
    elif src_ratio < dst_ratio:
        new_h = round(image.width / dst_ratio)
        top = (image.height - new_h) // 2
        image = image.crop((0, top, image.width, top + new_h))
    return image.resize((width, height), Image.LANCZOS)


def load_lora(pipe, path, scale):
    """Loads a LoRA from an https URL or a Hugging Face repo id.

    Hugging Face paths look like "owner/repo" or "owner/repo/file.safetensors".
    """
    if path.startswith("https://"):
        pipe.load_lora_weights(download_lora(path), adapter_name="user")
    else:
        parts = path.split("/")
        repo, weight_name = "/".join(parts[:2]), "/".join(parts[2:]) or None
        kwargs = {"weight_name": weight_name} if weight_name else {}
        pipe.load_lora_weights(repo, adapter_name="user", **kwargs)
    pipe.set_adapters(["user"], adapter_weights=[scale])


def download_lora(url):
    os.makedirs(LORA_CACHE, exist_ok=True)
    path = os.path.join(LORA_CACHE, hashlib.sha256(url.encode()).hexdigest()[:16] + ".safetensors")
    if not os.path.exists(path):
        tmp = path + ".part"
        with urllib.request.urlopen(url, timeout=60) as res, open(tmp, "wb") as f:
            while chunk := res.read(1 << 20):
                f.write(chunk)
        os.replace(tmp, path)
    return path
