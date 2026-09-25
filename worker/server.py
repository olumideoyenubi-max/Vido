"""Vido GPU worker: runs open-weight video models on this machine.

Implements the small HTTP API that Vido's `local` backend talks to:

    POST /jobs            {model, prompt, ...}  -> 202 {id, status}
    GET  /jobs/<id>       -> {id, status, progress, error}
    GET  /jobs/<id>/video -> the finished MP4
    GET  /health          -> {models, busy}

Jobs run one at a time on a single background thread, since one GPU can only
hold one model comfortably. Only the standard library is used here; the heavy
lifting lives in pipelines.py.
"""

import argparse
import base64
import binascii
import hmac
import json
import os
import queue
import re
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 12 * 1024 * 1024
MAX_PROMPT_LENGTH = 2000
IMAGE_DATA_URL = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$")
JOB_PATH = re.compile(r"^/jobs/([0-9a-f]{32})(/video)?$")


class JobQueue:
    """Runs generation jobs sequentially and remembers the most recent ones."""

    def __init__(self, runner, output_dir, max_jobs=100):
        self.runner = runner
        self.output_dir = output_dir
        self.max_jobs = max_jobs
        self.jobs = {}
        self.lock = threading.Lock()
        self.pending = queue.Queue()
        os.makedirs(output_dir, exist_ok=True)
        threading.Thread(target=self._work, daemon=True).start()

    def submit(self, params):
        job = {
            "id": uuid.uuid4().hex,
            "status": "queued",
            "progress": 0.0,
            "error": None,
            "path": None,
            "created": time.time(),
        }
        with self.lock:
            self.jobs[job["id"]] = job
            self._trim()
        self.pending.put((job["id"], params))
        return self.view(job["id"])

    def view(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            return {k: job[k] for k in ("id", "status", "progress", "error")}

    def video_path(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return job["path"] if job and job["status"] == "succeeded" else None

    def busy(self):
        with self.lock:
            return any(j["status"] in ("queued", "running") for j in self.jobs.values())

    def _update(self, job_id, **fields):
        with self.lock:
            if job_id in self.jobs:
                self.jobs[job_id].update(fields)

    def _work(self):
        while True:
            job_id, params = self.pending.get()
            with self.lock:
                if job_id not in self.jobs:
                    continue
            self._update(job_id, status="running")
            path = os.path.join(self.output_dir, f"{job_id}.mp4")

            def on_progress(fraction, job_id=job_id):
                self._update(job_id, progress=max(0.0, min(0.99, float(fraction))))

            try:
                self.runner.generate(params, path, on_progress)
                self._update(job_id, status="succeeded", progress=1.0, path=path)
            except Exception as err:  # report any model failure to the caller
                traceback.print_exc()
                self._update(job_id, status="failed", error=f"{type(err).__name__}: {err}")

    def _trim(self):
        finished = sorted(
            (j for j in self.jobs.values() if j["status"] in ("succeeded", "failed")),
            key=lambda j: j["created"],
        )
        for job in finished[: max(0, len(self.jobs) - self.max_jobs)]:
            del self.jobs[job["id"]]
            if job["path"] and os.path.exists(job["path"]):
                os.remove(job["path"])


def parse_job(body, models):
    """Validates a POST /jobs body. Returns (params, None) or (None, error)."""
    if not isinstance(body, dict):
        return None, "body must be a JSON object"
    model = body.get("model")
    if model not in models:
        return None, f"model must be one of {', '.join(sorted(models))}"
    spec = models[model]

    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return None, "prompt is required"
    if len(prompt) > MAX_PROMPT_LENGTH:
        return None, f"prompt must be at most {MAX_PROMPT_LENGTH} characters"

    aspect_ratio = body.get("aspect_ratio", "16:9")
    if aspect_ratio not in spec["sizes"]:
        return None, f"aspect_ratio must be one of {', '.join(spec['sizes'])}"
    duration = body.get("duration", 5)
    if duration not in spec["durations"]:
        return None, f"duration must be one of {spec['durations']}"

    seed = body.get("seed")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32):
        return None, "seed must be a non-negative integer"

    negative = body.get("negative_prompt")
    if negative is not None and not isinstance(negative, str):
        return None, "negative_prompt must be a string"

    image = None
    if body.get("image"):
        match = IMAGE_DATA_URL.match(str(body["image"]))
        if not match:
            return None, "image must be a base64 image data URL"
        try:
            image = base64.b64decode(match.group(2), validate=True)
        except binascii.Error:
            return None, "image is not valid base64"

    lora = body.get("lora")
    if lora is not None:
        if not isinstance(lora, dict) or not isinstance(lora.get("path"), str) or not lora["path"].strip():
            return None, "lora must be {path, scale}"
        scale = lora.get("scale", 1.0)
        if not isinstance(scale, (int, float)) or isinstance(scale, bool) or not 0 <= scale <= 2:
            return None, "lora.scale must be between 0 and 2"
        lora = {"path": lora["path"].strip(), "scale": float(scale)}

    return {
        "model": model,
        "prompt": prompt.strip(),
        "negative_prompt": negative or None,
        "aspect_ratio": aspect_ratio,
        "duration": duration,
        "seed": seed,
        "image": image,
        "lora": lora,
    }, None


def make_handler(jobs, models, token=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "VidoWorker/1.0"

        def log_message(self, fmt, *args):
            if os.environ.get("WORKER_QUIET") != "1":
                super().log_message(fmt, *args)

        def _json(self, status, data):
            payload = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _authorized(self):
            if not token:
                return True
            given = self.headers.get("Authorization", "")
            if hmac.compare_digest(given.encode(), f"Bearer {token}".encode()):
                return True
            self._json(401, {"error": "unauthorized"})
            return False

        def do_GET(self):
            if not self._authorized():
                return
            if self.path == "/health":
                return self._json(200, {"models": sorted(models), "busy": jobs.busy()})
            match = JOB_PATH.match(self.path)
            if not match:
                return self._json(404, {"error": "not found"})
            job_id, want_video = match.group(1), match.group(2)
            if not want_video:
                job = jobs.view(job_id)
                return self._json(200, job) if job else self._json(404, {"error": "job not found"})
            path = jobs.video_path(job_id)
            if not path or not os.path.exists(path):
                return self._json(404, {"error": "video not ready"})
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(os.path.getsize(path)))
            self.end_headers()
            with open(path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)

        def do_POST(self):
            if not self._authorized():
                return
            if self.path != "/jobs":
                return self._json(404, {"error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                return self._json(413, {"error": "request body too large"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid JSON"})
            params, error = parse_job(body, models)
            if error:
                return self._json(400, {"error": error})
            self._json(202, jobs.submit(params))

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default=os.environ.get("WORKER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WORKER_PORT", "8188")))
    parser.add_argument("--output-dir", default=os.environ.get("WORKER_OUTPUT_DIR", os.path.join(tempfile.gettempdir(), "vido-worker")))
    parser.add_argument("--preload", help="model id to load at startup, e.g. wan-2.2-5b")
    args = parser.parse_args()

    from pipelines import MODELS, DiffusersRunner  # imports torch; keep out of the tests' path

    runner = DiffusersRunner()
    if args.preload:
        runner.load(args.preload)
    token = os.environ.get("WORKER_TOKEN")
    if args.host not in ("127.0.0.1", "localhost") and not token:
        print("Warning: listening on a public interface without WORKER_TOKEN; anyone who can reach it can use your GPU.")

    jobs = JobQueue(runner, args.output_dir)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(jobs, MODELS, token))
    print(f"Vido worker on http://{args.host}:{args.port} (models: {', '.join(MODELS)})")
    server.serve_forever()


if __name__ == "__main__":
    main()
