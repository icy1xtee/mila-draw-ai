# msi — MSI Katana 17 B12V

Локальная работа на MSI. Почему роли распределены именно так, объясняет
[.claude/research/01-hardware.md](../.claude/research/01-hardware.md).

## Конфигурация

i7-12650H, 16 ГБ DDR5-4800 (2 слота, до 64 ГБ), Windows. Видеокарта зависит от суффикса:

| Суффикс | GPU             | VRAM |
| ------- | --------------- | ---- |
| B12VEK  | RTX 4050 Laptop | 6 ГБ |
| B12VFK  | RTX 4060 Laptop | 8 ГБ |
| B12VGK  | RTX 4070 Laptop | 8 ГБ |

**Точный суффикс пока не известен.** Как его узнать — в конце
[01-hardware.md](../.claude/research/01-hardware.md).

## Роль

Основная рабочая станция:

- ComfyUI;
- пачки фонов и спрайтов (VNCCS);
- обучение LoRA на Illustrious и Anima;
- сервер ComfyUI для Krita на Mac и для Claude Code (через comfyui-mcp).

LoRA для больших моделей (FLUX 3 Klein, Qwen) проще учить в облаке.

## Что ставим

1. **Драйвер NVIDIA** — свежий. Проверить `nvidia-smi` в PowerShell: видна карта и её память.
2. **Git.**
3. **ComfyUI** — [ComfyUI Desktop](https://www.comfy.org/download) для Windows или portable-сборка
   из [репозитория](https://github.com/Comfy-Org/ComfyUI). Плюс ComfyUI-Manager для установки
   custom nodes.
4. **Custom nodes:**
   - [ComfyUI_VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS) и VNCCS-Utils (нужен для Pose
     Studio) — конвейер спрайтов. Есть установщик
     [VNCCS Easy Install](https://github.com/AHEKOT/VNCCS_Easy-Install) со всем сразу;
   - ComfyUI-Impact-Pack — FaceDetailer, перерисовка лиц и рук;
   - ноды, которые требует Krita AI Diffusion (список в
     [документации плагина](https://docs.interstice.cloud));
   - BiRefNet — вырезание фона.
5. **Тренеры LoRA:**
   - [OneTrainer](https://github.com/Nerogar/OneTrainer) — Illustrious / SDXL;
   - [sd-scripts](https://github.com/kohya-ss/sd-scripts) — Anima и SDXL.

## Стартовый набор моделей

Займёт ≈ 80–120 ГБ на диске.

| Модель                                             | Для чего                                         | Примечание                                                     |
| -------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Illustrious-чекпойнт (WAI-Illustrious v16 или NoobAI-XL) | спрайты, style LoRA                        | ≈ 7 ГБ; NoobAI — некоммерческая лицензия                       |
| Anima: Base + Aesthetic + Turbo                    | фоны; Base — для обучения LoRA                   | три файла: DiT, текстовый энкодер Qwen3-0.6B, VAE Qwen-Image   |
| FLUX 3 Image Klein, INT8                           | правки по инструкции, референсы                  | на 6 ГБ — только с выгрузкой в RAM, медленно                   |
| Qwen-Image-2.1, GGUF                               | эксперименты, прозрачный фон                     | только после апгрейда RAM до 32 ГБ; некоммерческая лицензия    |
| апскейлер + BiRefNet                               | фоны до 2560×1440, вырезание спрайтов            | —                                                              |

## Настройки

- Работать от сети, MSI Center → режим **Extreme Performance**.
- **6 ГБ (B12VEK):** ComfyUI с `--lowvram`, fp8-веса, tiled VAE. Генерировать в ≈ 1 МП и
  апскейлить.
- **Доступ с Mac (Krita) и для Claude Code:**
  - ComfyUI слушает локальную сеть: `--listen 0.0.0.0 --port 8188` для portable или адрес
    сервера в настройках ComfyUI Desktop;
  - в брандмауэре Windows открыть порт 8188 только для частной сети.
  - У ComfyUI нет авторизации, поэтому в интернет его не выставлять.

## Апгрейд

**RAM до 32 ГБ** — 2×16 ГБ DDR5-4800 SO-DIMM. Обычно 16 ГБ стоят как 2×8, тогда меняются обе
планки. С 32 ГБ большие модели выгружаются в RAM без свопа на диск; для RTX 4050 6 ГБ это почти
обязательно.

## Что класть в эту папку

- **Да:**
  - воркфлоу ComfyUI в JSON (`workflows/`);
  - конфиги обучения LoRA (`training/`);
  - скрипты;
  - замеры скорости (`benchmarks.md`).
- **Нет:**
  - веса моделей и сгенерированные картинки — живут в папках ComfyUI;
  - датасеты — особенно работы художника: права на них отдельный вопрос.
