#!/usr/bin/env python3
"""Generate images through the Draw Things HTTP API.

Draw Things must be running with its API server on (Advanced → API Server: HTTP, port 7860).
A run file (JSON) says which models, seeds and prompts to draw and what for; models.json next to
this script holds each model's settings. Images go to the repo's content/ folder, laid out as
.claude/develop/mac/content.md describes: content/benchmarks/<date>-<run>/ for tests,
content/generated/<date>/<purpose>/ for the rest. Every image is saved as
<model>_<prompt>_<seed>.png with a .json beside it (the request sent, time and memory), and the
same record goes to log.jsonl in that folder. Images that already exist are skipped, so an
interrupted run picks up where it stopped (on another day, pass its folder with --out).

    python3 mac/scripts/dt_generate.py mac/scripts/smoke.json
    python3 mac/scripts/dt_generate.py RUN.json --models anima-turbo --force

Standard library only: runs on the system python3 (3.9).
"""

import argparse
import base64
import json
import re
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTENT = HERE.parent.parent / "content"
PURPOSES = ("benchmarks", "drafts", "backgrounds", "sprites", "edits")
WARMUP_SIZE = 512
SLUG = re.compile(r"^[a-z0-9-]+$")


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def txt2img(host, payload):
    request = urllib.request.Request(
        host + "/sdapi/v1/txt2img",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3600) as response:
            return base64.b64decode(json.load(response)["images"][0])
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')}") from None


def by_family(value, family, what, prompt_id):
    """A prompt's text is one string for every model or a dict keyed by model family."""
    if not isinstance(value, dict):
        return value
    if family not in value:
        sys.exit(f"prompt '{prompt_id}' has no {what} for the '{family}' family")
    return value[family]


def build_payload(config, model, prompt, seed, width, height):
    family = model["family"]
    text = by_family(prompt["prompt"], family, "prompt", prompt["id"])
    negative = ", ".join(
        part
        for part in (
            model.get("negative", ""),
            by_family(prompt.get("negative", ""), family, "negative", prompt["id"]),
        )
        if part
    )
    return {
        **config["base"],
        **model["params"],
        "prompt": model.get("prefix", "") + text,
        "negative_prompt": negative,
        "width": width,
        "height": height,
        "seed": seed,
    }


def run_text(*command):
    return subprocess.run(command, capture_output=True, text=True).stdout


def to_mb(number, unit):
    return float(number) * {"K": 1 / 1024, "M": 1, "G": 1024}[unit]


def footprint_mb(pid):
    """Draw Things' physical footprint, Metal buffers included (what Activity Monitor shows)."""
    match = re.search(r"Footprint:\s*([\d.]+)\s*([KMG])B", run_text("footprint", "-p", str(pid)))
    return to_mb(*match.groups()) if match else None


def swap_used_mb():
    match = re.search(r"used = ([\d.]+)([KMG])", run_text("sysctl", "-n", "vm.swapusage"))
    return to_mb(*match.groups()) if match else None


def power_source():
    return "ac" if "AC Power" in run_text("pmset", "-g", "batt") else "battery"


class MemorySampler:
    """Peak footprint of Draw Things and swap growth while one request runs."""

    def __init__(self, pid):
        self.pid = pid
        self.peak_mb = None
        self.swap_start = swap_used_mb()
        self.swap_peak = self.swap_start
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._sample, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join()

    def _sample(self):
        while True:
            mb = footprint_mb(self.pid) if self.pid else None
            if mb is not None:
                self.peak_mb = max(self.peak_mb or 0, mb)
            swap = swap_used_mb()
            if swap is not None and self.swap_peak is not None:
                self.swap_peak = max(self.swap_peak, swap)
            if self._stop.wait(1.0):
                return

    def result(self):
        growth = None
        if self.swap_start is not None and self.swap_peak is not None:
            growth = round(self.swap_peak - self.swap_start)
        return {
            "peak_footprint_mb": round(self.peak_mb) if self.peak_mb else None,
            "swap_growth_mb": growth,
        }


def png_size(data):
    return list(struct.unpack(">II", data[16:24]))


def check_run(config, run, model_keys):
    unknown = [key for key in model_keys if key not in config["models"]]
    if unknown:
        sys.exit(f"unknown models: {', '.join(unknown)} (see {HERE / 'models.json'})")
    if not SLUG.match(run["name"]):
        sys.exit(f"run name '{run['name']}': use lowercase letters, digits and dashes")
    if run.get("purpose") not in PURPOSES:
        sys.exit(f"run purpose must be one of: {', '.join(PURPOSES)}")
    for prompt in run["prompts"]:
        if not SLUG.match(prompt["id"]):
            sys.exit(f"prompt id '{prompt['id']}': use lowercase letters, digits and dashes")
        # Draw Things silently rounds other sizes to a multiple of 64.
        if prompt["width"] % 64 or prompt["height"] % 64:
            sys.exit(f"prompt '{prompt['id']}': width and height must be multiples of 64")


def output_folder(run):
    date = datetime.now().strftime("%Y-%m-%d")
    if run["purpose"] == "benchmarks":
        return CONTENT / "benchmarks" / f"{date}-{run['name']}"
    return CONTENT / "generated" / date / run["purpose"]


def main():
    parser = argparse.ArgumentParser(description="Draw images through the Draw Things API.")
    parser.add_argument("run", help="run file (JSON): name, purpose, models, seeds, prompts")
    parser.add_argument("--out", help="output folder instead of the one in content/")
    parser.add_argument("--models", help="only these models: keys from models.json, by commas")
    parser.add_argument("--force", action="store_true", help="redraw images that exist")
    parser.add_argument("--host", default="http://localhost:7860")
    args = parser.parse_args()

    config = load_json(HERE / "models.json")
    run = load_json(args.run)
    model_keys = args.models.split(",") if args.models else run["models"]
    check_run(config, run, model_keys)

    try:
        urllib.request.urlopen(args.host, timeout=5)
    except urllib.error.URLError:
        sys.exit(f"Draw Things API is not answering at {args.host}: is its API server on?")
    pid = run_text("pgrep", "-x", "DrawThings").split()
    pid = int(pid[0]) if pid else None

    out = Path(args.out).expanduser() if args.out else output_folder(run)
    out.mkdir(parents=True, exist_ok=True)
    failed = 0
    with open(out / "log.jsonl", "a", encoding="utf-8") as log:

        def record(entry):
            log.write(json.dumps(entry, ensure_ascii=False) + "\n")
            log.flush()

        for key in model_keys:
            model = config["models"][key]
            jobs = [
                (prompt, seed)
                for prompt in run["prompts"]
                for seed in run["seeds"]
                if args.force or not (out / f"{key}_{prompt['id']}_{seed}.png").exists()
            ]
            if not jobs:
                continue

            # The first request after a switch loads the model: time it apart from the images.
            print(f"{key}: loading {model['name']}", flush=True)
            warmup = build_payload(config, model, jobs[0][0], 0, WARMUP_SIZE, WARMUP_SIZE)
            started = time.monotonic()
            try:
                txt2img(args.host, warmup)
            except RuntimeError as e:
                print(f"  failed: {e}", flush=True)
                failed += len(jobs)
                continue
            seconds = round(time.monotonic() - started, 1)
            print(f"  warm-up {WARMUP_SIZE}² {seconds} s", flush=True)
            record({"kind": "warmup", "model": key, "seconds": seconds, "power": power_source()})

            for number, (prompt, seed) in enumerate(jobs, 1):
                name = f"{key}_{prompt['id']}_{seed}"
                payload = build_payload(
                    config, model, prompt, seed, prompt["width"], prompt["height"]
                )
                entry = {
                    "kind": "image",
                    "run": run["name"],
                    "purpose": run["purpose"],
                    "model": key,
                    "model_name": model["name"],
                    "prompt_id": prompt["id"],
                    "seed": seed,
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "power": power_source(),
                }
                started = time.monotonic()
                try:
                    with MemorySampler(pid) as memory:
                        image = txt2img(args.host, payload)
                except RuntimeError as e:
                    print(f"  [{number}/{len(jobs)}] {name}: failed: {e}", flush=True)
                    record({**entry, "error": str(e)})
                    failed += 1
                    continue
                entry["seconds"] = round(time.monotonic() - started, 1)
                entry.update(memory.result())
                entry["size"] = png_size(image)
                (out / f"{name}.png").write_bytes(image)
                (out / f"{name}.json").write_text(
                    json.dumps({**entry, "payload": payload}, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                record(entry)
                print(
                    f"  [{number}/{len(jobs)}] {name}: {entry['seconds']} s,"
                    f" peak {entry['peak_footprint_mb']} MB, swap +{entry['swap_growth_mb']} MB",
                    flush=True,
                )

    print(f"done: {out}" + (f", {failed} failed" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
