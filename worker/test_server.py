"""Tests for the worker's HTTP API and queue, using a fake model runner so
they run anywhere (no GPU, torch or diffusers needed):

    python -m unittest worker/test_server.py
"""

import base64
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from server import JobQueue, make_handler, parse_job  # noqa: E402

MODELS = {
    "wan-2.2-5b": {"sizes": {"16:9": (1280, 704), "1:1": (960, 960)}, "durations": [5]},
    "ltx-2": {"sizes": {"16:9": (960, 544)}, "durations": [5, 10]},
}
PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG fake").decode()


class FakeRunner:
    def __init__(self):
        self.calls = []

    def generate(self, params, path, on_progress):
        self.calls.append(params)
        if params["prompt"] == "explode":
            raise RuntimeError("CUDA out of memory")
        on_progress(0.5)
        with open(path, "wb") as f:
            f.write(b"fake mp4 for " + params["prompt"].encode())


class ParseJobTest(unittest.TestCase):
    def test_valid_request(self):
        params, error = parse_job(
            {"model": "ltx-2", "prompt": " waves ", "duration": 10, "seed": 7, "image": PNG, "lora": {"path": "a/b", "scale": 0.8}},
            MODELS,
        )
        self.assertIsNone(error)
        self.assertEqual(params["prompt"], "waves")
        self.assertEqual(params["image"], b"\x89PNG fake")
        self.assertEqual(params["lora"], {"path": "a/b", "scale": 0.8})

    def test_rejects_bad_input(self):
        cases = [
            ({"model": "nope", "prompt": "x"}, "model"),
            ({"model": "ltx-2"}, "prompt"),
            ({"model": "wan-2.2-5b", "prompt": "x", "duration": 10}, "duration"),
            ({"model": "ltx-2", "prompt": "x", "aspect_ratio": "1:1"}, "aspect_ratio"),
            ({"model": "ltx-2", "prompt": "x", "seed": -1}, "seed"),
            ({"model": "ltx-2", "prompt": "x", "image": "http://x/a.png"}, "image"),
            ({"model": "ltx-2", "prompt": "x", "lora": {"path": "a/b", "scale": 5}}, "lora.scale"),
        ]
        for body, field in cases:
            _, error = parse_job(body, MODELS)
            self.assertIn(field, error or "", body)


class ServerTest(unittest.TestCase):
    def setUp(self):
        os.environ["WORKER_QUIET"] = "1"
        self.dir = tempfile.mkdtemp()
        self.runner = FakeRunner()
        self.jobs = JobQueue(self.runner, self.dir)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.jobs, MODELS, token="s3cret"))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, path, body=None, token="s3cret"):
        req = urllib.request.Request(self.base + path, data=body and json.dumps(body).encode())
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req) as res:
                data = res.read()
                return res.status, data if res.headers["Content-Type"] == "video/mp4" else json.loads(data)
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def wait(self, job_id):
        for _ in range(200):
            status, job = self.request(f"/jobs/{job_id}")
            if job["status"] in ("succeeded", "failed"):
                return job
            time.sleep(0.01)
        self.fail("job did not finish")

    def test_generate_and_download(self):
        status, job = self.request("/jobs", {"model": "wan-2.2-5b", "prompt": "a fox"})
        self.assertEqual(status, 202)
        self.assertEqual(self.wait(job["id"])["status"], "succeeded")
        status, video = self.request(f"/jobs/{job['id']}/video")
        self.assertEqual((status, video), (200, b"fake mp4 for a fox"))

    def test_failed_generation_reports_error(self):
        _, job = self.request("/jobs", {"model": "ltx-2", "prompt": "explode"})
        done = self.wait(job["id"])
        self.assertEqual(done["status"], "failed")
        self.assertIn("CUDA out of memory", done["error"])
        self.assertEqual(self.request(f"/jobs/{job['id']}/video")[0], 404)

    def test_auth_and_errors(self):
        self.assertEqual(self.request("/health", token=None)[0], 401)
        self.assertEqual(self.request("/health", token="wrong")[0], 401)
        status, health = self.request("/health")
        self.assertEqual((status, health["models"]), (200, ["ltx-2", "wan-2.2-5b"]))
        self.assertEqual(self.request("/jobs", {"model": "ltx-2"})[0], 400)
        self.assertEqual(self.request("/jobs/" + "0" * 32)[0], 404)
        self.assertEqual(self.request("/nope")[0], 404)


class QueueTest(unittest.TestCase):
    def test_trims_old_finished_jobs_and_files(self):
        jobs = JobQueue(FakeRunner(), tempfile.mkdtemp(), max_jobs=2)
        ids = []
        for i in range(3):
            ids.append(jobs.submit({"prompt": f"p{i}"})["id"])
            for _ in range(200):
                if jobs.view(ids[-1])["status"] == "succeeded":
                    break
                time.sleep(0.01)
        first_path = os.path.join(jobs.output_dir, f"{ids[0]}.mp4")
        jobs.submit({"prompt": "p3"})
        self.assertIsNone(jobs.view(ids[0]))
        self.assertFalse(os.path.exists(first_path))


if __name__ == "__main__":
    unittest.main()
