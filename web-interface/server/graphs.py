"""ComfyUI graphs (API format) for each model family: text-to-image, LoRA, image-to-image.

Same graphs as msi/scripts/comfy_generate.py, plus LoRA and a base image; the script will move
onto this module so that both draw identical pictures.
"""


def _text(clip, value):
    return {"class_type": "CLIPTextEncode", "inputs": {"clip": clip, "text": value}}


def build(model, positive, negative, seed, width, height, loras=(), init_image=None,
          denoise=1.0, overrides=None):
    """model: an entry of msi/catalog/models.json. loras: [{file, strength}].
    init_image: a file name in ComfyUI's input folder (img2img), denoise: how much to change."""
    params = {**model["params"], **(overrides or {})}
    family, files = model["family"], model["files"]
    g = {}

    if family == "illustrious":
        g["ckpt"] = {"class_type": "CheckpointLoaderSimple",
                     "inputs": {"ckpt_name": files["checkpoint"]}}
        model_ref, clip_ref, vae_ref = ["ckpt", 0], ["ckpt", 1], ["ckpt", 2]
        for i, lora in enumerate(loras):
            node = f"lora{i}"
            g[node] = {"class_type": "LoraLoader", "inputs": {
                "model": model_ref, "clip": clip_ref, "lora_name": lora["file"],
                "strength_model": lora["strength"], "strength_clip": lora["strength"]}}
            model_ref, clip_ref = [node, 0], [node, 1]
        g["skip"] = {"class_type": "CLIPSetLastLayer", "inputs": {
            "clip": clip_ref, "stop_at_clip_layer": -params.get("clip_skip", 1)}}
        clip_ref = ["skip", 0]
    else:
        clip_type = {"anima": "stable_diffusion", "flux": "flux3"}[family]
        g["unet"] = {"class_type": "UNETLoader",
                     "inputs": {"unet_name": files["unet"], "weight_dtype": "default"}}
        g["clip"] = {"class_type": "CLIPLoader", "inputs": {
            "clip_name": files["clip"], "type": clip_type, "device": "default"}}
        g["vae"] = {"class_type": "VAELoader", "inputs": {"vae_name": files["vae"]}}
        model_ref, clip_ref, vae_ref = ["unet", 0], ["clip", 0], ["vae", 0]
        for i, lora in enumerate(loras):
            node = f"lora{i}"
            g[node] = {"class_type": "LoraLoaderModelOnly", "inputs": {
                "model": model_ref, "lora_name": lora["file"],
                "strength_model": lora["strength"]}}
            model_ref = [node, 0]
        if family == "flux":
            g["shift"] = {"class_type": "ModelSamplingFlux", "inputs": {
                "model": model_ref, "max_shift": params["shift"], "base_shift": params["shift"],
                "width": width, "height": height}}
            model_ref = ["shift", 0]

    g["pos"] = _text(clip_ref, positive)
    g["neg"] = _text(clip_ref, negative)

    if init_image:
        g["load"] = {"class_type": "LoadImage", "inputs": {"image": init_image}}
        g["scale"] = {"class_type": "ImageScale", "inputs": {
            "image": ["load", 0], "upscale_method": "lanczos", "width": width, "height": height,
            "crop": "center"}}
        g["latent"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["scale", 0], "vae": vae_ref}}
    else:
        latent = "EmptyFlux2LatentImage" if family == "flux" else "EmptyLatentImage"
        g["latent"] = {"class_type": latent,
                       "inputs": {"width": width, "height": height, "batch_size": 1}}
        denoise = 1.0

    g["sample"] = {"class_type": "KSampler", "inputs": {
        "model": model_ref, "positive": ["pos", 0], "negative": ["neg", 0],
        "latent_image": ["latent", 0], "seed": seed, "steps": params["steps"],
        "cfg": params["cfg"], "sampler_name": params["sampler"],
        "scheduler": params["scheduler"], "denoise": round(float(denoise), 3)}}
    g["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": vae_ref}}
    # PreviewImage writes to ComfyUI's temp folder; the keeper goes to content/.
    g["out"] = {"class_type": "PreviewImage", "inputs": {"images": ["decode", 0]}}
    return g


def remove_background(image, bg_model):
    """Image with transparent background. image: file in ComfyUI's input folder."""
    return {
        "load": {"class_type": "LoadImage", "inputs": {"image": image}},
        "bgm": {"class_type": "LoadBackgroundRemovalModel", "inputs": {"bg_removal_name": bg_model}},
        "mask": {"class_type": "RemoveBackground",
                 "inputs": {"bg_removal_model": ["bgm", 0], "image": ["load", 0]}},
        # RemoveBackground gives the foreground mask (1 = keep); JoinImageWithAlpha uses
        # 1 - mask as alpha, so invert first or the character becomes transparent.
        "inv": {"class_type": "InvertMask", "inputs": {"mask": ["mask", 0]}},
        "join": {"class_type": "JoinImageWithAlpha",
                 "inputs": {"image": ["load", 0], "alpha": ["inv", 0]}},
        "out": {"class_type": "PreviewImage", "inputs": {"images": ["join", 0]}},
    }


# Nodes whose execution means "loading the model" for the progress bar.
LOADER_NODES = {"ckpt", "unet", "clip", "vae", "skip", "shift", "bgm"} | {f"lora{i}" for i in range(8)}
