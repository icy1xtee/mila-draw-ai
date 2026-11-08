"""ComfyUI graphs (API format): text-to-image, image-to-image and FLUX reference editing.

Text-to-image is the same graph as msi/scripts/comfy_generate.py. FLUX editing follows the
official template image_flux3_klein_distilled_image_edit.json: reference pictures go through
ReferenceMultiLatent into both the positive and the (zeroed) negative, no ModelSamplingFlux.
"""


def _text(clip, value):
    return {"class_type": "CLIPTextEncode", "inputs": {"clip": clip, "text": value}}


def _loaders(g, model, params, loras, width, height, shift):
    family, files = model["family"], model["files"]
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
        return model_ref, ["skip", 0], vae_ref

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
            "model": model_ref, "lora_name": lora["file"], "strength_model": lora["strength"]}}
        model_ref = [node, 0]
    if family == "flux" and shift and params.get("shift"):
        g["shift"] = {"class_type": "ModelSamplingFlux", "inputs": {
            "model": model_ref, "max_shift": params["shift"], "base_shift": params["shift"],
            "width": width, "height": height}}
        model_ref = ["shift", 0]
    return model_ref, clip_ref, vae_ref


def build(model, positive, negative, seed, width=None, height=None, loras=(), init_image=None,
          denoise=1.0, overrides=None, references=()):
    """model: an entry of msi/catalog/models.json. loras: [{file, strength}].

    - text-to-image: no init_image, no references; width and height required;
    - image-to-image: init_image = a file in ComfyUI's input folder, scaled to width × height;
      denoise = how much to change it;
    - FLUX editing: references = files in ComfyUI's input folder (<ref_image_0>, ...);
      without width/height the result takes the first picture's proportions at ~1 MP.
    """
    edit = bool(references)
    base = model.get("edit_params") if edit and model.get("edit_params") else model["params"]
    params = {**model["params"], **base, **(overrides or {})}
    g = {}
    model_ref, clip_ref, vae_ref = _loaders(g, model, params, loras, width, height,
                                            shift=not edit)

    g["pos"] = _text(clip_ref, positive)
    if edit:
        g["zero"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}}
        g["ref"] = {"class_type": "ReferenceMultiLatent", "inputs": {
            "positive": ["pos", 0], "negative": ["zero", 0], "vae": vae_ref,
            "resolution": "resize", "resolution.megapixels": 1.0}}
        for i, name in enumerate(references):
            g[f"load{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
            g["ref"]["inputs"][f"images.image{i}"] = [f"load{i}", 0]
        positive_ref, negative_ref = ["ref", 0], ["ref", 1]
        if width and height:
            g["latent"] = {"class_type": "EmptyFlux2LatentImage",
                           "inputs": {"width": width, "height": height, "batch_size": 1}}
            latent_ref = ["latent", 0]
        else:
            latent_ref = ["ref", 2]
        denoise = 1.0
    else:
        g["neg"] = _text(clip_ref, negative)
        positive_ref, negative_ref = ["pos", 0], ["neg", 0]
        if init_image:
            g["load0"] = {"class_type": "LoadImage", "inputs": {"image": init_image}}
            g["scale"] = {"class_type": "ImageScale", "inputs": {
                "image": ["load0", 0], "upscale_method": "lanczos", "width": width,
                "height": height, "crop": "center"}}
            g["latent"] = {"class_type": "VAEEncode",
                           "inputs": {"pixels": ["scale", 0], "vae": vae_ref}}
        else:
            latent = "EmptyFlux2LatentImage" if model["family"] == "flux" else "EmptyLatentImage"
            g["latent"] = {"class_type": latent,
                           "inputs": {"width": width, "height": height, "batch_size": 1}}
            denoise = 1.0
        latent_ref = ["latent", 0]

    g["sample"] = {"class_type": "KSampler", "inputs": {
        "model": model_ref, "positive": positive_ref, "negative": negative_ref,
        "latent_image": latent_ref, "seed": seed, "steps": int(params["steps"]),
        "cfg": float(params["cfg"]), "sampler_name": params["sampler"],
        "scheduler": params["scheduler"], "denoise": round(float(denoise), 3)}}
    g["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": vae_ref}}
    # PreviewImage writes to ComfyUI's temp folder; the keeper goes to content/tasks/.
    g["out"] = {"class_type": "PreviewImage", "inputs": {"images": ["decode", 0]}}
    return g


def stage(node):
    """What the progress bar says while a node runs."""
    if node in ("ckpt", "unet", "clip", "vae", "skip", "shift") or node.startswith("lora"):
        return "Загружаю модель"
    if node.startswith("load") or node in ("scale", "ref", "zero"):
        return "Готовлю картинки"
    return {"sample": "Рисую", "decode": "Проявляю", "out": "Сохраняю"}.get(node)
