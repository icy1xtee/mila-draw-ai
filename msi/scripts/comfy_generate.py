#!/usr/bin/env python3
"""Generate images through the ComfyUI API (MSI).

ComfyUI must be running (msi/scripts/comfy_start.bat). The run file is the same JSON as on the
Mac (mac/scripts/dt_generate.py): name, purpose, models, seeds, prompts. msi/catalog/models.json
holds each model's files and settings for ComfyUI; the graph for each model family
is built here. Images go to the repo's content/ folder, laid out as
.claude/develop/mac/content.md describes: content/benchmarks/<date>-<run>/ for tests,
content/generated/<date>/<purpose>/ for the rest. Every image is saved as
<model>_<prompt>_<seed>.png with a .json beside it (the exact graph sent, time and memory), and
the same record goes to log.jsonl in that folder. Images that already exist are skipped, so an
interrupted run picks up where it stopped (on another day, pass its folder with --out).

    C:\\AI\\ComfyUI\\python_embeded\\python.exe -I msi\\scripts\\comfy_generate.py msi\\scripts\\smoke.json
    ... comfy_generate.py prompts\\bake-off.json --models anima-turbo --force

Standard library only: runs on ComfyUI's embedded Python or any Python 3.9+.
"""

import argparse
import ctypes
import json
import re
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTENT = HERE.parent.parent / "content"
CATALOG = HERE.parent / "catalog"
PURPOSES = ("benchmarks", "drafts", "backgrounds", "sprites", "edits")
WARMUP_SIZE = 512
SLUG = re.compile(r"^[a-z0-9-]+$")
CLIENT_ID = str(uuid.uuid4())


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# --- ComfyUI API -------------------------------------------------------------------------------


def api(host, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        host + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')}") from None
    return json.loads(raw) if raw else None


def fetch(host, image):
    query = urllib.parse.urlencode(
        {"filename": image["filename"], "subfolder": image["subfolder"], "type": image["type"]}
    )
    with urllib.request.urlopen(f"{host}/view?{query}", timeout=60) as response:
        return response.read()


def generate(host, graph):
    """Queue one graph, wait for it, return the PNG bytes of its PreviewImage."""
    answer = api(host, "/prompt", {"prompt": graph, "client_id": CLIENT_ID})
    prompt_id = answer["prompt_id"]
    deadline = time.monotonic() + 3600
    while time.monotonic() < deadline:
        history = api(host, f"/history/{prompt_id}")
        if prompt_id in history:
            item = history[prompt_id]
            status = item.get("status", {})
            if status.get("status_str") == "error":
                errors = [m[1] for m in status.get("messages", []) if m[0] == "execution_error"]
                detail = errors[0].get("exception_message", "").strip() if errors else ""
                raise RuntimeError(f"ComfyUI execution error: {detail or status}")
            for output in item.get("outputs", {}).values():
                if output.get("images"):
                    return fetch(host, output["images"][0])
            raise RuntimeError("no image in the output")
        time.sleep(0.25)
    raise RuntimeError("timed out after an hour")


def free_memory(host):
    """Unload models so the next model's load time is measured from a clean state."""
    api(host, "/free", {"unload_models": True, "free_memory": True})


# --- Graphs (ComfyUI API format) ---------------------------------------------------------------


def sampler(model, params, seed, positive, negative, latent):
    return {
        "class_type": "KSampler",
        "inputs": {
            "model": model,
            "positive": positive,
            "negative": negative,
            "latent_image": latent,
            "seed": seed,
            "steps": params["steps"],
            "cfg": params["cfg"],
            "sampler_name": params["sampler"],
            "scheduler": params["scheduler"],
            "denoise": 1.0,
        },
    }


def text(clip, value):
    return {"class_type": "CLIPTextEncode", "inputs": {"clip": clip, "text": value}}


def tail(graph, vae):
    graph["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": vae}}
    # PreviewImage writes to ComfyUI's temp folder (cleared on start): the keeper is in content/.
    graph["out"] = {"class_type": "PreviewImage", "inputs": {"images": ["decode", 0]}}
    return graph


def graph_anima(files, params, prompt, negative, seed, width, height):
    return tail(
        {
            "unet": {
                "class_type": "UNETLoader",
                "inputs": {"unet_name": files["unet"], "weight_dtype": "default"},
            },
            "clip": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": files["clip"], "type": "stable_diffusion", "device": "default"},
            },
            "vae": {"class_type": "VAELoader", "inputs": {"vae_name": files["vae"]}},
            "pos": text(["clip", 0], prompt),
            "neg": text(["clip", 0], negative),
            "latent": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "sample": sampler(["unet", 0], params, seed, ["pos", 0], ["neg", 0], ["latent", 0]),
        },
        ["vae", 0],
    )


def graph_flux(files, params, prompt, negative, seed, width, height):
    return tail(
        {
            "unet": {
                "class_type": "UNETLoader",
                "inputs": {"unet_name": files["unet"], "weight_dtype": "default"},
            },
            "shift": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["unet", 0],
                    "max_shift": params["shift"],
                    "base_shift": params["shift"],
                    "width": width,
                    "height": height,
                },
            },
            "clip": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": files["clip"], "type": "flux3", "device": "default"},
            },
            "vae": {"class_type": "VAELoader", "inputs": {"vae_name": files["vae"]}},
            "pos": text(["clip", 0], prompt),
            "neg": text(["clip", 0], negative),
            "latent": {
                "class_type": "EmptyFlux2LatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "sample": sampler(["shift", 0], params, seed, ["pos", 0], ["neg", 0], ["latent", 0]),
        },
        ["vae", 0],
    )


def graph_sdxl(files, params, prompt, negative, seed, width, height):
    return tail(
        {
            "ckpt": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": files["checkpoint"]},
            },
            "skip": {
                "class_type": "CLIPSetLastLayer",
                "inputs": {"clip": ["ckpt", 1], "stop_at_clip_layer": -params.get("clip_skip", 1)},
            },
            "pos": text(["skip", 0], prompt),
            "neg": text(["skip", 0], negative),
            "latent": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "sample": sampler(["ckpt", 0], params, seed, ["pos", 0], ["neg", 0], ["latent", 0]),
        },
        ["ckpt", 2],
    )


GRAPHS = {"anima": graph_anima, "flux": graph_flux, "illustrious": graph_sdxl}


def by_family(value, family, what, prompt_id):
    """A prompt's text is one string for every model or a dict keyed by model family."""
    if not isinstance(value, dict):
        return value
    if family not in value:
        sys.exit(f"prompt '{prompt_id}' has no {what} for the '{family}' family")
    return value[family]


def build_graph(model, prompt, seed, width, height):
    family = model["family"]
    positive = model.get("prefix", "") + by_family(prompt["prompt"], family, "prompt", prompt["id"])
    negative = ", ".join(
        part
        for part in (
            model.get("negative", ""),
            by_family(prompt.get("negative", ""), family, "negative", prompt["id"]),
        )
        if part
    )
    return GRAPHS[family](model["files"], model["params"], positive, negative, seed, width, height)


# --- Memory and power (Windows) ----------------------------------------------------------------


class MemoryStatus(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def ram_used_mb():
    """RAM in use by the whole system."""
    try:
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(MemoryStatus)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        return (status.ullTotalPhys - status.ullAvailPhys) / 2**20
    except (AttributeError, OSError):
        return None


def vram_used_mb():
    """Memory in use on the NVIDIA GPU (all processes; the desktop runs on Intel UHD)."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
        return float(out.split()[0])
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None


class PowerStatus(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_byte),
        ("BatteryFlag", ctypes.c_byte),
        ("BatteryLifePercent", ctypes.c_byte),
        ("SystemStatusFlag", ctypes.c_byte),
        ("BatteryLifeTime", ctypes.c_ulong),
        ("BatteryFullLifeTime", ctypes.c_ulong),
    ]


def power_source():
    try:
        status = PowerStatus()
        ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status))
        return {1: "ac", 0: "battery"}.get(status.ACLineStatus)
    except (AttributeError, OSError):
        return None


class MemorySampler:
    """Peak VRAM and system RAM while one request runs."""

    def __init__(self):
        self.vram = None
        self.ram = None
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
            vram, ram = vram_used_mb(), ram_used_mb()
            if vram is not None:
                self.vram = max(self.vram or 0, vram)
            if ram is not None:
                self.ram = max(self.ram or 0, ram)
            if self._stop.wait(0.5):
                return

    def result(self):
        return {
            "peak_vram_mb": round(self.vram) if self.vram else None,
            "peak_ram_mb": round(self.ram) if self.ram else None,
        }


# --- Run ---------------------------------------------------------------------------------------


def png_size(data):
    return list(struct.unpack(">II", data[16:24]))


def check_run(config, run, model_keys):
    unknown = [key for key in model_keys if key not in config["models"]]
    if unknown:
        sys.exit(f"unknown models: {', '.join(unknown)} (see {CATALOG / 'models.json'})")
    if not SLUG.match(run["name"]):
        sys.exit(f"run name '{run['name']}': use lowercase letters, digits and dashes")
    if run.get("purpose") not in PURPOSES:
        sys.exit(f"run purpose must be one of: {', '.join(PURPOSES)}")
    for prompt in run["prompts"]:
        if not SLUG.match(prompt["id"]):
            sys.exit(f"prompt id '{prompt['id']}': use lowercase letters, digits and dashes")
        # Same rule as on the Mac, so one run file draws the same sizes on both machines.
        if prompt["width"] % 64 or prompt["height"] % 64:
            sys.exit(f"prompt '{prompt['id']}': width and height must be multiples of 64")


def output_folder(run):
    date = datetime.now().strftime("%Y-%m-%d")
    if run["purpose"] == "benchmarks":
        return CONTENT / "benchmarks" / f"{date}-{run['name']}"
    return CONTENT / "generated" / date / run["purpose"]


def main():
    parser = argparse.ArgumentParser(description="Draw images through the ComfyUI API.")
    parser.add_argument("run", help="run file (JSON): name, purpose, models, seeds, prompts")
    parser.add_argument("--out", help="output folder instead of the one in content/")
    parser.add_argument("--models", help="only these models: keys from models.json, by commas")
    parser.add_argument("--force", action="store_true", help="redraw images that exist")
    parser.add_argument("--host", default="http://127.0.0.1:8188")
    args = parser.parse_args()

    config = load_json(CATALOG / "models.json")
    run = load_json(args.run)
    model_keys = args.models.split(",") if args.models else run["models"]
    check_run(config, run, model_keys)

    try:
        api(args.host, "/system_stats", timeout=5)
    except (urllib.error.URLError, RuntimeError, OSError):
        sys.exit(f"ComfyUI is not answering at {args.host}: start msi/scripts/comfy_start.bat")

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

            # Unload the previous model, then a small request loads this one: time it apart.
            print(f"{key}: loading {model['name']}", flush=True)
            free_memory(args.host)
            warmup = build_graph(model, jobs[0][0], 0, WARMUP_SIZE, WARMUP_SIZE)
            started = time.monotonic()
            try:
                with MemorySampler() as memory:
                    generate(args.host, warmup)
            except RuntimeError as e:
                print(f"  failed: {e}", flush=True)
                failed += len(jobs)
                continue
            seconds = round(time.monotonic() - started, 1)
            print(f"  warm-up {WARMUP_SIZE}x{WARMUP_SIZE} {seconds} s", flush=True)
            record(
                {"kind": "warmup", "model": key, "seconds": seconds, "power": power_source(),
                 **memory.result()}
            )

            for number, (prompt, seed) in enumerate(jobs, 1):
                name = f"{key}_{prompt['id']}_{seed}"
                graph = build_graph(model, prompt, seed, prompt["width"], prompt["height"])
                entry = {
                    "kind": "image",
                    "run": run["name"],
                    "purpose": run["purpose"],
                    "machine": "msi",
                    "model": key,
                    "model_name": model["name"],
                    "prompt_id": prompt["id"],
                    "seed": seed,
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "power": power_source(),
                }
                started = time.monotonic()
                try:
                    with MemorySampler() as memory:
                        image = generate(args.host, graph)
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
                    json.dumps({**entry, "payload": graph}, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                record(entry)
                print(
                    f"  [{number}/{len(jobs)}] {name}: {entry['seconds']} s,"
                    f" VRAM {entry['peak_vram_mb']} MB, RAM {entry['peak_ram_mb']} MB",
                    flush=True,
                )

    print(f"done: {out}" + (f", {failed} failed" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
