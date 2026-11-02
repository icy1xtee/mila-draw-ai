# 03. Инструменты: интерфейсы, тренеры, утилиты

Звёзды GitHub и дата последнего коммита сняты через GitHub API 28.10.2026.

## Интерфейсы для генерации

| Инструмент                                                                 | ★ GitHub | Последний коммит | Где               | Зачем нам                                                                                                                         |
| -------------------------------------------------------------------------- | -------- | ---------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI)                            | 143 741  | 28.10.2026       | Katana (и Mac)    | **основной движок.** Ноды, JSON-воркфлоу, локальный API, первым поддерживает новые модели (FLUX 3 Klein, Qwen-Image-2.1, Anima). Релиз v0.43.0 — 27.10 |
| [Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion)           | 10 797   | 03.10.2026       | Katana / Mac      | **правки «как художник»**: выделил область → перерисовал, регионы, control layers, live-режим. Работает поверх ComfyUI. Поддерживает Illustrious, Anima (регионы, Scribble / LineArt, сегментация), FLUX.2 klein, Z-Image, Qwen-Image 2.1 |
| [Draw Things](https://drawthings.ai) ([движок](https://github.com/drawthingsai/draw-things-community)) | 605 (движок) | 28.10.2026 | **Mac**     | **лучший вариант на Mac**: свой Metal-движок, быстрее ComfyUI. Поддерживает FLUX 3 Klein (с 23.10), Qwen-Image 2.1, Anima, Z-Image, SDXL. Inpaint, обучение LoRA. Бесплатно |
| [InvokeAI](https://github.com/invoke-ai/InvokeAI)                          | 28 899   | 28.10.2026       | —                 | хороший холст для художника, но новые модели получает позже ComfyUI                                                                |
| [AUTOMATIC1111](https://github.com/AUTOMATIC1111/stable-diffusion-webui)   | 165 174  | 02.03.2026       | —                 | исторический лидер по звёздам, но фактически заброшен и не поддерживает DiT-модели 2026 года                                       |
| [Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge)        | 13 088   | 31.07.2025       | —                 | заброшен                                                                                                                          |
| [Fooocus](https://github.com/lllyasviel/Fooocus)                           | 53 715   | 01.12.2025       | —                 | только SDXL, в режиме поддержки                                                                                                   |
| [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI)                     | 4 713    | 27.10.2026       | —                 | удобная обёртка над ComfyUI; можно, но не обязательно                                                                              |
| [mflux](https://github.com/mflux-community/mflux)                          | 2 545    | 27.10.2026       | Mac               | CLI на MLX для FLUX-семейства, на случай скриптов на Mac                                                                           |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)     | 7 813    | 28.10.2026       | —                 | C++ движок с GGUF; запасной путь для Qwen-Image-2.1                                                                                |

**Вывод:**

- Katana — ComfyUI + Krita AI Diffusion поверх него.
- Mac — Draw Things и, по желанию, Krita AI с подключением к ComfyUI на Katana по сети. Krita
  на Mac берём v1.53 для Krita 5: предрелиз 1.54 для Krita 6 «known to perform poorly on macOS».

## Специально для визуальных новелл

### [ComfyUI_VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS) — Visual Novel Character Creation Suite

★ 1 720, MIT, коммит 27.10.2026. Полный конвейер спрайтов одного персонажа:

1. **Character Creator / Cloner** — создать персонажа по описанию или клонировать из готовой
   картинки (концепт-арт, рисунок художника). Pose Studio задаёт набор поз.
2. **Clothes** — комплекты одежды, есть клонирование одежды с картинки.
3. **Emotions** — набор эмоций на все позы и костюмы. На выбор Illustrious (стабильно), Anima
   («очень классные эмоции, но нестабильно»), Qwen Image 2.1 (меняет только лицо, остальное не
   трогает).
4. **Удаление фона** — хромакей + SAM3 для деталей того же цвета, что фон. Qwen Image 2.1 сразу
   даёт прозрачный фон.
5. (опц.) **Датасет для LoRA персонажа** из полученных спрайтов.

Генераторы внутри: Qwen Image 2.1, FLUX.2 klein 9B, MiniMax H3. Обращать внимание на лицензии
этих моделей (см. [02-models.md](02-models.md)).

## Обучение LoRA (стиль художника, персонажи)

| Тренер                                                          | ★ GitHub | Что умеет                                                                                         | Для нас                                           |
| --------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts)   | 7 252    | SDXL / Illustrious / NoobAI, **Anima** (`anima_train_network.py`)                                  | стандарт для SDXL и Anima                         |
| [kohya_ss GUI](https://github.com/bmaltais/kohya_ss)            | 12 641   | GUI над sd-scripts                                                                                | если удобнее без командной строки                 |
| [OneTrainer](https://github.com/Nerogar/OneTrainer)             | 3 254    | SDXL, FLUX и др.; удобные превью во время обучения; хорошо экономит VRAM                          | **первый выбор для SDXL-LoRA на 8 ГБ**            |
| [Ostris AI Toolkit](https://github.com/ostris/ai-toolkit)       | 12 496   | FLUX.2 / **FLUX 3 Klein** (с первого дня), Qwen-Image-2.1, Z-Image                                | LoRA для редакторов, в облаке                     |
| [musubi-tuner](https://github.com/kohya-ss/musubi-tuner)        | 2 119    | Qwen-Image, Z-Image Base, Krea 2, Wan                                                             | большие DiT                                       |
| [diffusion-pipe](https://github.com/tdrussell/diffusion-pipe)   | 2 032    | Anima (рекомендован в model card), многие DiT                                                      | альтернатива для Anima                            |
| [SimpleTuner](https://github.com/bghira/SimpleTuner)            | 2 949    | многие модели, есть поддержка MPS                                                                 | если захочется обучать на Mac из скрипта          |
| Draw Things (встроенный)                                        | —        | SDXL, FLUX.2 klein, Z-Image, Qwen Image, Anima                                                    | обучение на Mac без настройки (медленно)          |

Ориентиры по обучению ([airmore, окт 2026](https://airmore.ai/lora-training-guide.html)):

- **SDXL / Illustrious:**
  - rank 16–32, alpha = rank, LR UNet 1e-4, текстовые энкодеры заморожены;
  - бакеты 1024;
  - сначала 100–200 шагов на пробу;
  - для NoobAI v-pred нужны v-pred настройки.
- **Anima:**
  - учить на **Base**, а не на Aesthetic / Turbo;
  - rank 8–32, LR ≈ 2e-5 для rank 32 (model card) или 1e-4 для rank 8;
  - LLM-адаптер не обучать.
- **Датасет:** 20–50 разных картинок на персонажа. Для стиля нужно шире и разнообразнее по
  сюжетам — 50–150 работ художника.

## Утилиты

| Утилита                                                                | ★     | Зачем                                                                                    |
| ---------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet)                     | 4 334 | вырезание фона у спрайтов (MIT), есть ноды для ComfyUI                                   |
| [Qwen-Image-Layered](https://github.com/QwenLM/Qwen-Image-Layered)     | 2 156 | разложение картинки на RGBA-слои, Apache 2.0. Пригодится, чтобы разобрать фон на планы (параллакс), но рекомендуется 640 px и модель тяжёлая (20B) |
| [DiffSynth-Studio](https://github.com/modelscope/DiffSynth-Studio)     | 13 318| low-VRAM скрипты, в том числе для Anima                                                  |
| FaceDetailer / ADetailer (Impact Pack для ComfyUI)                     | —     | автоматическая перерисовка лиц и рук — главный способ убрать артефакты                   |
| Апскейл: Ultimate SD Upscale (тайлами той же моделью) / SeedVR2 / ESRGAN-аниме модели | — | довести фон до 1920×1080 / 2560×1440 без потери стиля                     |

## Связка с Claude Code — «контекст проекта»

| Инструмент                                                                    | ★   | Что делает                                                                                                                  |
| ----------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------- |
| [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp)                 | 876 | MIT, коммит 26.10.2026. MCP-сервер и плагин Claude Code для **локального** ComfyUI: генерирует, запускает и правит воркфлоу естественным языком |
| [Acly/comfyui-tooling-nodes](https://github.com/Acly/comfyui-tooling-nodes)   | 681 | ноды для использования ComfyUI как бэкенда внешних инструментов (на них же стоит Krita AI)                                   |
| Официальный Comfy Cloud MCP ([docs](https://docs.comfy.org/development/cloud/mcp-server)) | — | только для облачного Comfy, нам не подходит, если хотим локально                                              |

Идея: в репозитории `mila-draw-ai` лежат описания персонажей, локаций, палитры и шаблоны
промптов, а также JSON-воркфлоу ComfyUI. Claude Code читает их и через MCP запускает генерацию
на Katana — так «понимание контекста» живёт в репозитории, а не в памяти модели.
