"""ComfyUI graphs (API format): text-to-image, image-to-image and FLUX reference editing.

Text-to-image is the same graph as msi/scripts/comfy_generate.py. FLUX editing follows the
official template image_flux3_klein_distilled_image_edit.json: reference pictures go through
ReferenceMultiLatent into both the positive and the (zeroed) negative, no ModelSamplingFlux.

Hires fix (tag models, as in A1111/Forge): the picture is drawn, enlarged by an upscale model
(RealESRGAN anime) to `scale` × the size, and drawn over again with `denoise` — the second
pass adds the detail. Big pictures go through the tiled VAE (8 GB of VRAM).
"""

UPSCALER = "RealESRGAN_x4plus_anime_6B.pth"  # models/upscale_models/; the same as on Civitai


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
          denoise=1.0, overrides=None, references=(), hires=None, upscalers=()):
    """model: an entry of msi/catalog/models.json. loras: [{file, strength}].

    - text-to-image: no init_image, no references; width and height required;
    - image-to-image: init_image = a file in ComfyUI's input folder, scaled to width × height;
      denoise = how much to change it;
    - FLUX editing: references = files in ComfyUI's input folder (<ref_image_0>, ...);
      without width/height the result takes the first picture's proportions at ~1 MP.
    - hires: {scale, denoise, steps, cfg or None} — the second pass (not with references);
      upscalers = upscale models ComfyUI has; without ours the picture is scaled with lanczos.
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
    image_ref = ["decode", 0]
    if hires and not edit and width and height:
        w, h = hires_size(width, height, hires["scale"])
        if UPSCALER in upscalers:
            g["up_model"] = {"class_type": "UpscaleModelLoader", "inputs": {"model_name": UPSCALER}}
            g["up"] = {"class_type": "ImageUpscaleWithModel",
                       "inputs": {"upscale_model": ["up_model", 0], "image": image_ref}}
            image_ref = ["up", 0]
        g["up_scale"] = {"class_type": "ImageScale", "inputs": {
            "image": image_ref, "upscale_method": "lanczos", "width": w, "height": h,
            "crop": "disabled"}}
        g["up_enc"] = {"class_type": "VAEEncodeTiled", "inputs": {
            "pixels": ["up_scale", 0], "vae": vae_ref, "tile_size": 1024, "overlap": 64,
            "temporal_size": 64, "temporal_overlap": 8}}
        g["hires"] = {"class_type": "KSampler", "inputs": {
            **g["sample"]["inputs"], "latent_image": ["up_enc", 0],
            "steps": int(hires["steps"]),
            "cfg": float(hires["cfg"] if hires.get("cfg") not in (None, "") else params["cfg"]),
            "denoise": round(float(hires["denoise"]), 3)}}
        g["hires_decode"] = {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["hires", 0], "vae": vae_ref, "tile_size": 768, "overlap": 64,
            "temporal_size": 64, "temporal_overlap": 8}}
        image_ref = ["hires_decode", 0]
    # PreviewImage writes to ComfyUI's temp folder; the keeper goes to content/tasks/.
    g["out"] = {"class_type": "PreviewImage", "inputs": {"images": image_ref}}
    return g


def hires_size(width, height, scale, step=8):
    return round(width * scale / step) * step, round(height * scale / step) * step


def stage(node):
    """What the progress bar says while a node runs."""
    if node in ("ckpt", "unet", "clip", "vae", "skip", "shift") or node.startswith("lora"):
        return "Загружаю модель"
    if node.startswith("load") or node in ("scale", "ref", "zero"):
        return "Готовлю картинки"
    if node in ("up_model", "up", "up_scale", "up_enc"):
        return "Увеличиваю"
    return {"sample": "Рисую", "decode": "Проявляю", "hires": "Дорисовываю детали",
            "hires_decode": "Проявляю", "out": "Сохраняю"}.get(node)
