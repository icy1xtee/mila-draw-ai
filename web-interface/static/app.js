// Mila Draw AI — the page. Plain ES module: no build step, no libraries.

const $ = (sel, root = document) => root.querySelector(sel);
const MAX_PICTURES = 4;
const SHOW_TAGS = 8; // tags visible before «ещё N»

// Element builder: h("div", {class: "x", onclick: fn}, child, "text", [more]).
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  return el;
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("mila:" + key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("mila:" + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers["Content-Type"] = "application/json";
  }
  const r = await fetch(path, init);
  if (r.status === 401) {
    showLogin();
    throw new Error("Нужно войти");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `Ошибка ${r.status}`);
  return data;
}

const enc = (rel) => rel.split("/").map(encodeURIComponent).join("/");
const fileUrl = (rel) => "/files/" + enc(rel);
const thumbUrl = (rel, size = 480) => `/thumbs/${enc(rel)}?size=${size}`;

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}

function timeText(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + ", " + time;
}

function seconds(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, "0")} с`;
}

function toast(text, kind = "error") {
  const el = h("div", { class: `toast ${kind}` }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add("gone"), 3800);
  setTimeout(() => el.remove(), 4300);
}

// replaceChildren without the false/null/"" that conditional children leave behind.
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false && c !== ""));
}

function render(node) {
  fill($("#view"), node);
  window.scrollTo(0, 0);
}

// --- state ----------------------------------------------------------------------------------

const S = {
  catalog: null,
  status: null,
  statusAt: 0,
  view: null,
  task: null,
  draft: null,
  ui: null,
  uploading: false,
  assisting: false,
  brainstorming: false,
};

// Models a brainstorm draws in by default (fast and different from each other).
const BRAINSTORM_MODELS = ["anima-turbo", "wai-illustrious", "flux3-klein"];

// --- start and login ------------------------------------------------------------------------

async function boot() {
  const s = await fetch("/api/session").then((r) => r.json()).catch(() => ({ authed: false }));
  if (!s.authed) return showLogin();
  await start();
}

async function start() {
  $("#top").classList.remove("hidden");
  S.catalog = await api("/api/catalog");
  if (!S.catalog.models.length) {
    render(h("div", { class: "page" }, h("p", { class: "error" }, "В каталоге нет моделей.")));
    return;
  }
  pollStatus();
  route();
}

function showLogin() {
  S.view = "login";
  $("#top").classList.add("hidden");
  const input = h("input", { type: "password", placeholder: "Пароль", autocomplete: "current-password" });
  const error = h("p", { class: "error hidden" });
  const form = h("form", {
    class: "card login",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api("/api/login", { body: { password: input.value } });
        await start();
      } catch (x) {
        error.textContent = x.message;
        error.classList.remove("hidden");
      }
    },
  }, h("h1", {}, "Mila Draw AI"), input, h("button", { class: "btn primary big", type: "submit" }, "Войти"), error);
  render(h("div", { class: "page narrow" }, form));
  input.focus();
}

function route() {
  const m = location.hash.match(/^#\/t\/([^/?]+)/);
  if (m) openTask(decodeURIComponent(m[1]));
  else openTasks();
}
window.addEventListener("hashchange", () => S.catalog && route());

// --- tasks ----------------------------------------------------------------------------------

async function openTasks() {
  S.view = "tasks";
  S.task = null;
  const data = await api("/api/tasks");
  const title = h("input", { placeholder: "Название задачи (можно пусто)", maxlength: 120 });
  const create = h("form", {
    class: "card new-task",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const t = await api("/api/tasks", { body: { title: title.value } });
        location.hash = "#/t/" + t.id;
      } catch (x) { toast(x.message); }
    },
  }, h("div", { class: "row" }, title, h("button", { class: "btn primary", type: "submit" }, "Новая задача")));
  const list = data.tasks.length
    ? h("div", { class: "task-grid" }, data.tasks.map(taskCard))
    : h("p", { class: "muted" }, "Задач пока нет.");
  render(h("div", { class: "page" }, create, list));
}

function taskCard(t) {
  return h("a", { class: "task-card", href: "#/t/" + t.id },
    t.cover ? h("img", { src: thumbUrl(t.cover, 480), alt: "", loading: "lazy" }) : h("div", { class: "cover-empty" }),
    h("div", { class: "task-card-body" },
      h("b", {}, t.title),
      h("span", { class: "small muted" }, `${plural(t.count, "картинка", "картинки", "картинок")} · ${timeText(t.updated)}`)));
}

// --- task: draft ----------------------------------------------------------------------------

function loadDraft(taskId) {
  const saved = store.get("draft:" + taskId, {});
  const d = {
    images: [], kind: "character", action: null, white_bg: false,
    model: store.get("model", S.catalog.models[0].key),
    prompt: "", negative: "", undo: null, wish: "", tip: null,
    count: 1, seed: "", size: null, denoise: null,
    brainstorm: false, bsWish: "", bsCount: 4, bsModels: null, ideas: [],
    ...saved,
  };
  delete d.original; // drafts from before the AI helper
  if (!S.catalog.models.some((m) => m.key === d.model)) d.model = S.catalog.models[0].key;
  if (d.action && !S.catalog.actions.some((a) => a.id === d.action)) d.action = null; // removed preset
  const files = new Set(S.task.items.map((i) => i.file));
  d.images = d.images.filter((f) => files.has(f)).slice(0, MAX_PICTURES);
  // An action that needs references keeps a model that takes them.
  const action = S.catalog.actions.find((a) => a.id === d.action);
  const current = S.catalog.models.find((m) => m.key === d.model);
  if (d.images.length && action?.references && !current.references) {
    d.model = (S.catalog.models.find((m) => m.references) || current).key;
  }
  return d;
}

function saveDraft() {
  store.set("draft:" + S.task.id, S.draft);
  store.set("model", S.draft.model);
}

const model = () => S.catalog.models.find((m) => m.key === S.draft.model) || S.catalog.models[0];
const item = (file) => S.task.items.find((i) => i.file === file);

function mode() {
  if (!S.draft.images.length) return "text";
  return model().references ? "edit" : "img2img";
}

function preset() {
  return S.draft.images.length
    ? S.catalog.actions.find((a) => a.id === S.draft.action) || null
    : S.catalog.kinds.find((k) => k.id === S.draft.kind) || null;
}

const isBrainstorm = () => S.draft.images.length > 0 && S.draft.action === "from-photo" && S.draft.brainstorm;

function settingsFor(m, md = mode()) {
  const base = (md === "edit" && m.edit_params) || m.params;
  const saved = store.get("settings:" + m.key, {});
  return {
    steps: base.steps, cfg: base.cfg, sampler: base.sampler, scheduler: base.scheduler,
    quality: true, loras: [],
    ...saved,
    hires: { ...hiresDefaults(m), ...(saved.hires || {}) },
  };
}

// Hires fix: the second pass in a bigger size (tag models; as «Hires fix» in A1111/Forge).
function hiresDefaults(m) {
  return { on: false, scale: 1.5, denoise: 0.5, steps: Math.max(4, Math.round(m.params.steps * 0.7)), cfg: "" };
}
const hiresWorks = (m, md) => m.tags && md !== "edit";
const DEFAULT_UPSCALER = "RealESRGAN_x4plus_anime_6B.pth";
const UPSCALER_NOTES = {
  "RealESRGAN_x4plus_anime_6B.pth": "под аниме: чистые линии, ровные заливки (стандарт)",
  "4x_foolhardy_Remacri.safetensors": "универсальный: сохраняет фактуру и мелкие детали — ближе к полуреализму",
};

function hiresSize(w, h, scale) {
  return { w: Math.round((w * scale) / 8) * 8, h: Math.round((h * scale) / 8) * 8 };
}

function sizeNow() {
  if (S.draft.size) return S.draft.size;
  const key = (S.catalog.kinds.find((k) => k.id === S.draft.kind) || {}).size || "square";
  const s = S.catalog.sizes[key];
  return { w: s.width, h: s.height };
}

function denoiseNow() {
  return S.draft.denoise ?? (preset() || {}).denoise ?? 0.6;
}

// --- task: page -----------------------------------------------------------------------------

async function openTask(id) {
  S.view = "task";
  try {
    S.task = await api(`/api/tasks/${encodeURIComponent(id)}`);
  } catch (e) {
    render(h("div", { class: "page" }, h("p", { class: "error" }, e.message), h("a", { href: "#/" }, "← Задачи")));
    return;
  }
  S.draft = loadDraft(S.task.id);
  jobCards.clear();
  S.importNote = null;
  failedCards.clear();
  const ui = (S.ui = {});

  ui.title = h("h1", { class: "task-title" }, S.task.title);
  ui.attach = h("section", { class: "block attach" });
  ui.presets = h("section", { class: "block" });
  ui.model = h("section", { class: "block" });
  // AI helper: Mila writes what she wants, Claude fills the prompt and suggests settings.
  ui.wish = h("textarea", {
    rows: 3, value: S.draft.wish,
    placeholder: "Своими словами, по-русски: что хотите получить. Помощник заполнит промпт и подскажет настройки",
    oninput: () => { S.draft.wish = ui.wish.value; saveDraft(); renderAssistant(); },
  });
  ui.assistantOut = h("div", { class: "assistant-out" });
  ui.assistant = h("section", { class: "block assistant" },
    h("label", { class: "label" }, "ИИ-помощник"),
    clearable(ui.wish, () => { ui.wish.value = S.draft.wish = ""; saveDraft(); renderAssistant(); }),
    ui.assistantOut);

  ui.prompt = h("textarea", {
    rows: 4, value: S.draft.prompt, onpaste: pastePrompt,
    oninput: () => { S.draft.prompt = ui.prompt.value; S.draft.undo = null; saveDraft(); renderPromptTools(); },
  });
  ui.promptTools = h("div", { class: "row prompt-tools" });
  ui.negative = h("textarea", {
    rows: 2, value: S.draft.negative, onpaste: pastePrompt,
    oninput: () => { S.draft.negative = ui.negative.value; S.draft.undo = null; saveDraft(); renderPromptTools(); },
  });
  ui.negativeBox = h("details", { class: "negative", open: !!S.draft.negative },
    h("summary", {}, "Негативный промпт"),
    clearable(ui.negative, () => setPrompt(ui.prompt.value, "")));
  ui.promptBlock = h("section", { class: "block" },
    h("label", { class: "label" }, "Промпт"),
    clearable(ui.prompt, () => setPrompt("", undefined)),
    ui.promptTools, ui.negativeBox);
  ui.submit = h("button", { class: "btn primary big", onclick: submit }, "Нарисовать");

  // Brainstorm (inside «Дизайн по фото»): ideas from the photo, drawn in several models.
  ui.bsWish = h("input", {
    value: S.draft.bsWish, maxlength: 300,
    placeholder: "Необязательно: «девочка-подросток, фэнтези»",
    oninput: () => { S.draft.bsWish = ui.bsWish.value; saveDraft(); },
  });
  ui.bsOut = h("div", { class: "block" });
  ui.brainstorm = h("section", { class: "block brainstorm" },
    h("label", { class: "label" }, "Мозговой штурм"),
    h("p", { class: "small muted" },
      "Claude посмотрит фото и придумает разных персонажей по его мотивам. Потом каждую идею " +
      "нарисуют выбранные модели — по описанию, без фото: так они не копируют исходник, а " +
      "фантазируют. Понравившуюся картинку откройте и нажмите «Доработать»."),
    field("Пожелание", ui.bsWish),
    ui.bsOut);

  ui.loras = h("section", { class: "block loras-block" });
  ui.jobs = h("div", { class: "task-jobs" });
  ui.history = h("div", { class: "history" });

  const composer = h("div", { class: "composer card" },
    ui.attach, ui.presets, ui.brainstorm, ui.model, ui.loras, ui.assistant, ui.promptBlock, ui.submit);

  render(h("div", { class: "page task" },
    h("div", { class: "task-head" },
      h("a", { class: "back", href: "#/" }, "← Задачи"),
      ui.title,
      h("button", { class: "icon-btn", title: "Переименовать", onclick: renameTask }, "✎"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn danger", title: "Удалить задачу со всеми картинками", onclick: deleteTask }, "Удалить")),
    h("div", { class: "task-layout" },
      h("div", { class: "task-left" }, composer),
      h("div", { class: "task-right" }, ui.jobs, ui.history))));

  refreshComposer();
  renderHistory();
  renderTaskJobs();
  pollTask();
}

async function renameTask() {
  const title = window.prompt("Название задачи", S.task.title);
  if (title === null || title.trim() === S.task.title) return;
  if (!title.trim()) {
    toast("Название не может быть пустым");
    return;
  }
  try {
    const t = await api(`/api/tasks/${S.task.id}`, { method: "PATCH", body: { title } });
    S.task.title = t.title;
    S.ui.title.textContent = t.title;
  } catch (e) { toast(e.message); }
}

async function deleteTask() {
  const pictures = S.task.items.length;
  const what = pictures ? ` и ${plural(pictures, "картинку", "картинки", "картинок")} в ней` : "";
  if (!window.confirm(`Удалить задачу «${S.task.title}»${what}?\n\nВсё удалится с MSI насовсем, вернуть нельзя.`)) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(S.task.id)}`, { method: "DELETE" });
    try { localStorage.removeItem("mila:draft:" + S.task.id); } catch { /* private mode */ }
    toast(`Задача «${S.task.title}» удалена`, "info");
    location.hash = "#/";
  } catch (e) { toast(e.message); }
}

async function reloadTask() {
  if (S.view !== "task" || !S.task) return;
  const id = S.task.id;
  const fresh = await api(`/api/tasks/${encodeURIComponent(id)}`).catch(() => null);
  if (!fresh || S.view !== "task" || S.task?.id !== id) return;
  const changed = JSON.stringify(fresh.items) !== JSON.stringify(S.task.items);
  S.task = fresh;
  if (changed) {
    renderAttach();
    renderHistory();
  }
}

let taskTimer = null;
function pollTask() {
  clearTimeout(taskTimer);
  taskTimer = setTimeout(async () => {
    if (S.view !== "task") return;
    if (S.task.items.some((i) => (i.analysis || {}).status === "pending")) await reloadTask();
    pollTask();
  }, 2500);
}

function refreshComposer() {
  renderAttach();
  renderPresets();
  const bs = isBrainstorm();
  const ui = S.ui;
  ui.brainstorm.classList.toggle("hidden", !bs);
  for (const el of [ui.model, ui.loras, ui.promptBlock, ui.submit]) el.classList.toggle("hidden", bs);
  ui.assistant.classList.toggle("hidden", bs || !S.catalog.claude);
  if (bs) {
    renderBrainstorm();
    return;
  }
  renderModel();
  renderLoras();
  renderAssistant();
  renderPromptTools();
  const m = model();
  S.ui.negativeBox.classList.toggle("hidden", !m.negative_works);
  const how = S.catalog.claude ? " — по-английски, или попросите ИИ-помощника выше" : " — по-английски";
  S.ui.prompt.placeholder = (mode() === "text" ? "Что нарисовать" : "Что поменять или добавить") + how;
  const n = S.draft.count;
  S.ui.submit.textContent = n > 1 ? `Нарисовать ×${n}` : "Нарисовать";
}

// --- attached pictures ----------------------------------------------------------------------

function renderAttach() {
  const ui = S.ui;
  const cards = S.draft.images.map((file, i) => {
    const it = item(file);
    return h("div", { class: "attached" },
      h("button", { class: "attached-img", onclick: () => openViewer(file) },
        h("img", { src: thumbUrl(file, 320), alt: "" }),
        S.draft.images.length > 1 && h("span", { class: "badge" }, i + 1)),
      h("div", { class: "attached-body" }, it ? analysisView(it, true) : null),
      h("button", { class: "icon-btn remove", title: "Убрать из генерации", onclick: () => detach(file) }, "✕"));
  });
  const full = S.draft.images.length >= MAX_PICTURES;
  fill(ui.attach, 
    h("label", { class: "label" }, "Картинки"),
    ...cards,
    !full && h("button", { class: "drop", disabled: S.uploading, onclick: () => $("#file-picker").click() },
      S.uploading ? "Загружаю…" : S.draft.images.length ? "＋ Ещё картинка" : "＋ Прикрепить картинку"));
}

function analysisView(it, interactive) {
  const a = it.analysis || {};
  if (a.status === "pending") return h("p", { class: "small muted thinking" }, "Claude смотрит картинку…");
  if (a.status === "off") return h("p", { class: "small muted" }, "Claude недоступен");
  if (a.status === "error") {
    return h("div", {},
      h("p", { class: "small error" }, "Не получилось описать: " + (a.message || "")),
      h("button", { class: "link", onclick: () => describe(it.file, true) }, "Повторить"));
  }
  if (a.status !== "done") {
    return interactive && S.catalog.claude
      ? h("button", { class: "link", onclick: () => describe(it.file) }, "Описать картинку")
      : null;
  }
  // tags = what is in the picture; medium = how it is made (sketch, monochrome…). Medium tags
  // describe the input, not the wish: they never go in with «＋ все теги».
  let tags = splitTags(a.tags);
  let medium = splitTags(a.medium);
  if (a.medium === undefined) { // descriptions made before the split
    medium = tags.filter((t) => MEDIUM.has(t));
    tags = tags.filter((t) => !MEDIUM.has(t));
  }
  const tagButton = (t) => interactive
    ? h("button", { class: "tag", title: "В промпт", onclick: () => addToPrompt(t) }, t)
    : h("span", { class: "tag" }, t);
  const box = h("div", { class: "tags" });
  const drawTags = (all) => {
    const shown = all ? tags : tags.slice(0, SHOW_TAGS);
    fill(box,
      interactive && tags.length > 0 && h("button", { class: "tag all", onclick: () => addToPrompt(tags.join(", ")) }, "＋ все теги"),
      shown.map(tagButton),
      !all && tags.length > SHOW_TAGS && h("button", { class: "tag more", onclick: () => drawTags(true) },
        `ещё ${tags.length - SHOW_TAGS}`));
  };
  drawTags(false);
  return h("div", { class: "analysis" },
    a.description && h("p", {
      class: "description clamp", onclick: (e) => e.currentTarget.classList.toggle("clamp"),
    }, a.description),
    tags.length > 0 && box,
    medium.length > 0 && h("div", { class: "tags medium" }, h("span", { class: "small muted" }, "техника:"), medium.map(tagButton)));
}

const splitTags = (text) => (text || "").split(",").map((t) => t.trim()).filter(Boolean);

// Technique tags, for descriptions made before Claude returned them separately.
const MEDIUM = new Set(["sketch", "rough sketch", "lineart", "monochrome", "greyscale", "colored sketch",
  "traditional media", "digital media (artwork)", "photo (medium)", "graphite (medium)", "pencil (medium)",
  "ink (medium)", "unfinished", "partially colored", "flat color", "spot color"]);

async function describe(file, again = false) {
  try {
    await api("/api/describe", { body: { file, again } });
    await reloadTask();
    pollTask();
  } catch (e) { toast(e.message); }
}

function addToPrompt(text) {
  const cur = S.ui.prompt.value.trim();
  // Tags already in the prompt are not added again (pressing «＋ все теги» twice changes nothing).
  const have = new Set(splitTags(cur.toLowerCase()));
  const fresh = splitTags(text).filter((t) => !have.has(t.toLowerCase()));
  if (!fresh.length) return;
  text = fresh.join(", ");
  S.ui.prompt.value = cur ? `${cur.replace(/[,\s]+$/, "")}, ${text}` : text;
  S.draft.prompt = S.ui.prompt.value;
  S.draft.undo = null;
  saveDraft();
  renderPromptTools();
}

function attach(file) {
  if (isBrainstorm()) {
    // A brainstorm result to work on: it replaces the photo, the brainstorm is over.
    Object.assign(S.draft, { images: [file], action: null, brainstorm: false, denoise: null });
    saveDraft();
    refreshComposer();
    toast("Картинка прикреплена — выберите, что с ней сделать", "info");
    S.ui.attach.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (S.draft.images.includes(file)) return;
  if (S.draft.images.length >= MAX_PICTURES) {
    toast(`Не больше ${MAX_PICTURES} картинок`);
    return;
  }
  S.draft.images.push(file);
  saveDraft();
  refreshComposer();
  const it = item(file);
  if (it && !it.analysis && S.catalog.claude) describe(file);
  S.ui.attach.scrollIntoView({ behavior: "smooth", block: "start" });
}

function detach(file) {
  S.draft.images = S.draft.images.filter((f) => f !== file);
  saveDraft();
  refreshComposer();
}

async function uploadFiles(files) {
  if (S.view !== "task") return;
  files = [...files].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!files.length) return;
  const room = MAX_PICTURES - S.draft.images.length;
  if (room <= 0) {
    toast(`Не больше ${MAX_PICTURES} картинок`);
    return;
  }
  if (files.length > room) toast(`Беру первые ${room}: не больше ${MAX_PICTURES} картинок`, "info");
  const form = new FormData();
  files.slice(0, room).forEach((f) => form.append("files", f, f.name));
  S.uploading = true;
  renderAttach();
  try {
    const res = await api(`/api/tasks/${S.task.id}/uploads`, { body: form });
    for (const it of res.saved) S.draft.images.push(it.file);
    saveDraft();
    await reloadTask();
  } catch (e) {
    toast(e.message);
  } finally {
    S.uploading = false;
    refreshComposer();
    pollTask();
  }
}

$("#file-picker").addEventListener("change", (e) => {
  uploadFiles(e.target.files);
  e.target.value = "";
});
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (S.view === "task" && files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
});
document.addEventListener("dragover", (e) => { if (S.view === "task") e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (S.view !== "task") return;
  e.preventDefault();
  uploadFiles(e.dataTransfer.files);
});

// --- presets --------------------------------------------------------------------------------

function renderPresets() {
  const images = S.draft.images.length > 0;
  const m = model();
  const p = preset();
  let choice;
  if (images) {
    // Actions as cards with a description: what each one takes and what it gives.
    const list = [...S.catalog.actions, {
      id: null, title: "Свой промпт",
      description: "Ничего не добавляется: модель делает только то, что написано в промпте.",
    }];
    choice = h("div", { class: "options" }, list.map((a) =>
      h("button", {
        class: "option" + ((S.draft.action || null) === a.id ? " on" : ""),
        onclick: () => chooseAction(a.id ? a : null),
      }, h("b", {}, a.title), h("span", { class: "small" }, a.description))));
  } else {
    choice = [
      h("div", { class: "chips" }, S.catalog.kinds.map((k) => chip(k.title, S.draft.kind === k.id, () => {
        S.draft.kind = k.id;
        S.draft.size = null;
        saveDraft();
        refreshComposer();
      }))),
      p && p.description && h("p", { class: "small muted" }, p.description),
    ];
  }
  const bs = isBrainstorm();
  const key = m.tags ? "tags" : "text";
  const adds = p && !bs ? [p[key], p.white_bg && S.draft.white_bg ? S.catalog.white_bg[key] : ""].filter(Boolean) : [];
  fill(S.ui.presets,
    h("label", { class: "label" }, images ? "Что сделать" : "Что рисуем"),
    choice,
    images && S.draft.action === "from-photo" && h("div", { class: "chips sub-mode" },
      chip("Один вариант", !S.draft.brainstorm, () => setBrainstorm(false)),
      chip("Мозговой штурм", S.draft.brainstorm, () => setBrainstorm(true))),
    p && p.white_bg && h("label", { class: "check" },
      h("input", {
        type: "checkbox", checked: S.draft.white_bg,
        onchange: (e) => { S.draft.white_bg = e.target.checked; saveDraft(); renderPresets(); },
      }), S.catalog.white_bg.title),
    adds.length > 0 && h("p", { class: "adds small muted" }, "Добавится: ", h("span", {}, adds.join(m.tags ? ", " : " "))));
}

function setBrainstorm(on) {
  S.draft.brainstorm = on;
  saveDraft();
  refreshComposer();
}

function chip(text, on, onclick, disabled = false) {
  return h("button", { class: "chip" + (on ? " on" : ""), onclick, disabled }, text);
}

function chooseAction(a) {
  S.draft.action = a ? a.id : null;
  S.draft.denoise = null;
  if (a && a.model && S.catalog.models.some((m) => m.key === a.model)) {
    S.draft.model = a.model; // the model that does this action best; the user can change it
  } else if (a && a.references && !model().references) {
    const ref = S.catalog.models.find((m) => m.references);
    if (ref) S.draft.model = ref.key;
  }
  saveDraft();
  refreshComposer();
}

// --- model ----------------------------------------------------------------------------------

function renderModel() {
  const m = model();
  const p = preset();
  const needRefs = !!(p && p.references);
  const select = h("select", {
    onchange: (e) => { S.draft.model = e.target.value; saveDraft(); refreshComposer(); },
  }, S.catalog.models.map((x) => h("option", {
    value: x.key, selected: x.key === m.key, disabled: needRefs && !x.references,
  }, x.title)));
  const st = settingsFor(m);
  const md = mode();
  const parts = [`${st.steps} шагов`];
  if (S.draft.count > 1) parts.push(`${S.draft.count} шт.`);
  if (md === "text") parts.push(`${sizeNow().w}×${sizeNow().h}`);
  if (md === "img2img") parts.push(`сила ${denoiseNow()}`);
  if (S.draft.seed !== "" && S.draft.seed != null) parts.push(`seed ${S.draft.seed}`);
  if (st.hires.on && hiresWorks(m, md)) {
    const f = md === "text" ? hiresSize(sizeNow().w, sizeNow().h, st.hires.scale) : null;
    parts.push(f ? `hires → ${f.w}×${f.h}` : `hires ×${String(st.hires.scale).replace(".", ",")}`);
  }
  const loras = (st.loras || []).filter((l) => l.on).length;
  if (loras) parts.push(`LoRA: ${loras}`);
  const note = md === "img2img" && S.draft.images.length > 1
    ? "Эта модель возьмёт только первую картинку."
    : needRefs && !m.references ? "Для этой заготовки нужна модель с референсами." : "";
  fill(S.ui.model, 
    h("label", { class: "label" }, "Модель"),
    h("div", { class: "row model-row" }, select,
      h("button", { class: "btn help-btn", title: "Как писать промпт для этой модели", onclick: openHelp }, "?"),
      h("button", { class: "btn", onclick: openSettings }, "Настройки")),
    h("p", { class: "small muted settings-line" }, parts.join(" · ")),
    note && h("p", { class: "small warn" }, note));
}

// --- LoRA -----------------------------------------------------------------------------------
// The catalog (msi/catalog/loras.json) says what each LoRA does, its trigger, variants, optional
// words, strength and the author's settings. State per model: settings:<model>.loras =
// [{file, on, strength, variant}].

const LORA_KINDS = [
  ["style", "Стиль", "меняет манеру рисунка; две стилевые вместе дают кашу"],
  ["concept", "Приём", "особый вид картинки"],
  ["clothes", "Одежда", "конкретный наряд"],
  ["effect", "Эффект", "свет, плёнка, материал"],
  ["detail", "Детали", "больше мелочей, стиль почти не трогают"],
  ["quality", "Качество", "общая эстетика картинки"],
  ["service", "Служебные", "нужны редко"],
  ["other", "Без описания", "файл есть, описания нет — пришлите ссылку на Civitai"],
];
S.loraOpen = new Set();
const num = (x) => String(x).replace(".", ",");

// LoRA of the model's family; files of unknown family go with every model, marked.
const lorasFor = (m) => S.catalog.loras.filter((l) => !l.family || l.family === m.family);

function loraState(m, file) {
  return ((store.get("settings:" + m.key, {}).loras) || []).find((x) => x.file === file);
}

function setLora(m, file, patch) {
  const saved = store.get("settings:" + m.key, {});
  const list = [...(saved.loras || [])];
  const i = list.findIndex((x) => x.file === file);
  const l = S.catalog.loras.find((x) => x.file === file) || {};
  const next = { file, on: false, strength: l.strength ?? 0.8, ...(i >= 0 ? list[i] : {}), ...patch };
  if (i >= 0) list[i] = next; else list.push(next);
  store.set("settings:" + m.key, { ...saved, loras: list });
}

function renderLoras() {
  const ui = S.ui;
  const m = model();
  const all = lorasFor(m);
  ui.loras.classList.toggle("hidden", !all.length || isBrainstorm());
  if (!all.length) return;
  const on = all.filter((l) => loraState(m, l.file)?.on);
  const open = S.lorasShowAll || false;
  const shown = open ? all : on;
  const styles = on.filter((l) => l.kind === "style").length;
  fill(ui.loras,
    h("div", { class: "row label-row" },
      h("label", { class: "label" }, "LoRA"),
      on.length > 0 && h("span", { class: "pill" }, `включено: ${on.length}`),
      h("span", { class: "spacer" }),
      h("button", { class: "link", onclick: () => { S.lorasShowAll = !open; renderLoras(); } },
        open ? "Свернуть" : on.length ? "Изменить" : `Выбрать (${all.length})`)),
    !open && !on.length && h("p", { class: "small muted" },
      `Дообучения поверх модели: стиль, детали, одежда, эффект. Для ${m.title} есть ${all.length} — нажмите «Выбрать».`),
    open && h("p", { class: "small muted" },
      "Галочка включает LoRA, ползунок — сила (насколько сильно она влияет). Слово-ключ добавится в " +
      "промпт само. Здесь только LoRA, которые подходят к выбранной модели. «Подробнее» — как " +
      "пользоваться и чего не делать. Документация — msi/catalog/loras.md."),
    on.length > 3 && h("p", { class: "small warn" }, "Больше трёх LoRA сразу обычно портят картинку."),
    styles > 1 && h("p", { class: "small warn" }, "Включено несколько стилевых LoRA — стили смешаются. Обычно оставляют одну."),
    LORA_KINDS.map(([kind, title, note]) => {
      const group = shown.filter((l) => (l.kind || "other") === kind);
      return group.length > 0 && h("div", { class: "lora-group" },
        open && h("p", { class: "lora-kind" }, h("b", {}, title), h("span", { class: "small muted" }, " — " + note)),
        group.map((l) => loraCard(m, l)));
    }));
}

function loraCard(m, l) {
  const st = loraState(m, l.file) || { on: false, strength: l.strength };
  const isOpen = S.loraOpen.has(l.file);
  const value = h("b", { class: "small" }, num(st.strength));
  const variant = st.variant || l.variants?.[0]?.word;
  const adds = [l.trigger, l.variants?.length ? variant : ""].filter(Boolean).join(", ");
  const lic = l.license || {};
  const s = l.settings || {};
  const settingsText = [s.sampler && `сэмплер ${s.sampler}`, s.scheduler && `планировщик ${s.scheduler}`,
    s.cfg != null && `CFG ${s.cfg}`, s.steps && `${s.steps} шагов`].filter(Boolean).join(", ");
  const toggleOpen = () => { if (isOpen) S.loraOpen.delete(l.file); else S.loraOpen.add(l.file); renderLoras(); };
  return h("div", { class: "lora-card" + (st.on ? " on" : "") },
    h("div", { class: "lora-head" },
      h("label", { class: "check" },
        h("input", { type: "checkbox", checked: st.on, onchange: (e) => { setLora(m, l.file, { on: e.target.checked }); refreshComposer(); } }),
        h("b", {}, l.title)),
      lic.images_commercial === false && h("span", { class: "pill muted-pill", title: "Автор не разрешает продавать картинки: для этюдов, не для ассетов игры" }, "не для продажи"),
      h("span", { class: "spacer" }),
      h("button", { class: "link small-link", onclick: toggleOpen }, isOpen ? "Скрыть" : "Подробнее")),
    h("p", { class: "small muted" }, l.hint || (l.family ? "Описания нет — пришлите ссылку на Civitai." : "Описания нет, и непонятно, к какой модели она подходит.")),
    st.on && h("div", { class: "lora-controls" },
      h("div", { class: "row" }, h("span", { class: "small" }, "Сила"),
        h("input", {
          type: "range", min: l.range[0], max: l.range[1], step: 0.05, value: st.strength,
          oninput: (e) => { value.textContent = num(e.target.value); },
          onchange: (e) => { setLora(m, l.file, { strength: +e.target.value }); },
        }), value),
      l.variants?.length > 0 && h("label", { class: "small lora-variant" }, "Вариант",
        h("select", { onchange: (e) => { setLora(m, l.file, { variant: e.target.value }); renderLoras(); } },
          l.variants.map((v) => h("option", { value: v.word, selected: v.word === variant }, v.title)))),
      adds && h("p", { class: "small" }, "В промпт добавится само: ", h("code", {}, adds)),
      l.words?.length > 0 && h("div", { class: "tags" },
        h("span", { class: "small muted" }, "по желанию:"),
        l.words.map((w) => h("button", { class: "tag", title: w.text, onclick: () => addToPrompt(w.text) }, "＋ " + w.title))),
      settingsText && h("button", {
        class: "link", title: "Автор этой LoRA советует такие настройки модели",
        onclick: () => applyLoraSettings(m, l),
      }, `Поставить настройки автора: ${settingsText}`)),
    isOpen && h("div", { class: "lora-details small" },
      (l.how || []).length > 0 && h("div", {}, h("b", {}, "Как использовать"), h("ul", {}, l.how.map((x) => h("li", {}, x)))),
      (l.avoid || []).length > 0 && h("div", {}, h("b", {}, "Как не надо"), h("ul", {}, l.avoid.map((x) => h("li", {}, x)))),
      h("p", {}, h("b", {}, "Сила: "), `по умолчанию ${num(l.strength)}, можно ${num(l.range[0])}…${num(l.range[1])}`),
      l.described !== false && h("p", {}, h("b", {}, "Лицензия: "),
        lic.images_commercial ? "автор разрешает продавать картинки" : "продавать картинки нельзя — для себя и этюдов",
        lic.note ? `. ${lic.note}` : ""),
      h("p", { class: "muted" }, [l.version, l.author && `автор ${l.author}`, l.file].filter(Boolean).join(" · "),
        l.source && [" · ", h("a", { href: l.source, target: "_blank", rel: "noopener" }, "Civitai")])));
}

function applyLoraSettings(m, l) {
  const s = l.settings || {};
  const next = { ...store.get("settings:" + m.key, {}) };
  const has = (list, x) => !list.length || list.includes(x);
  if (s.sampler && has(S.catalog.samplers, s.sampler)) next.sampler = s.sampler;
  if (s.scheduler && has(S.catalog.schedulers, s.scheduler)) next.scheduler = s.scheduler;
  if (s.cfg != null) next.cfg = s.cfg;
  if (s.steps) next.steps = s.steps;
  store.set("settings:" + m.key, next);
  toast(`Настройки автора «${l.title}» применены — вернуть: «Сбросить» в окне настроек`, "info");
  refreshComposer();
}

// --- prompt: clear, undo --------------------------------------------------------------------

// A textarea with a ✕ in the corner that empties it in one tap.
function clearable(input, onClear) {
  const btn = h("button", { class: "clear-btn", type: "button", title: "Очистить", onclick: () => { onClear(); box.sync(); input.focus(); } }, "✕");
  const box = h("div", { class: "clearable" }, input, btn);
  const sync = () => btn.classList.toggle("hidden", !input.value);
  input.addEventListener("input", sync);
  box.sync = sync;
  sync();
  clearables.add(box);
  return box;
}
const clearables = new Set();
const syncClear = () => clearables.forEach((b) => (b.isConnected ? b.sync() : clearables.delete(b)));

// Replace the prompt (and the negative, if given), remembering the old text for «Вернуть».
function setPrompt(prompt, negative) {
  S.draft.undo = { prompt: S.ui.prompt.value, negative: S.ui.negative.value };
  S.ui.prompt.value = S.draft.prompt = prompt;
  if (negative !== undefined) {
    S.ui.negative.value = S.draft.negative = negative;
    if (negative) S.ui.negativeBox.open = true;
  }
  saveDraft();
  renderPromptTools();
}

function renderPromptTools() {
  const ui = S.ui;
  syncClear();
  const u = S.draft.undo;
  const changed = u && (u.prompt !== ui.prompt.value || u.negative !== ui.negative.value);
  fill(ui.promptTools,
    changed && h("button", {
      class: "link",
      onclick: () => {
        ui.prompt.value = S.draft.prompt = u.prompt;
        ui.negative.value = S.draft.negative = u.negative;
        S.draft.undo = null;
        saveDraft();
        renderPromptTools();
      },
    }, "↶ Вернуть как было"),
    h("span", { class: "spacer" }),
    h("button", { class: "link", title: "Промпт и настройки из Civitai, A1111, Forge", onclick: openImport }, "⇩ Вставить параметры"),
    S.importNote && h("div", { class: "tip import-note" },
      h("p", {}, h("b", {}, "Перенесено: "), S.importNote.done.join(" · ") || "—"),
      S.importNote.skipped.length > 0 && h("p", { class: "small" }, h("b", {}, "Не перенесено: "), S.importNote.skipped.join(" · ")),
      h("button", { class: "link small-link", onclick: () => { S.importNote = null; renderPromptTools(); } }, "Скрыть")));
}

// --- generation parameters from Civitai / A1111 / Forge ---------------------------------------
// The text that «Copy generation data» on Civitai gives (and A1111/Forge write into PNG):
//   <prompt>
//   Negative prompt: <negative>
//   Steps: 30, CFG scale: 7, Sampler: Euler a, Seed: 1, Size: 1024x1344, Hires upscale: 2, ...
// Everything that has a place here is applied: model, prompt, negative, size, steps, CFG,
// sampler, scheduler, seed, hires fix, LoRA; the rest is listed as «не перенесено».

const looksLikeParams = (t) => /(^|\n)\s*Steps:\s*\d+/.test(t) && /(CFG scale|Sampler|Seed):/.test(t);

const A1111_SAMPLERS = {
  "euler a": "euler_ancestral", euler: "euler", heun: "heun", lms: "lms", ddim: "ddim", lcm: "lcm",
  "dpm++ 2m": "dpmpp_2m", "dpm++ 2m sde": "dpmpp_2m_sde", "dpm++ 3m sde": "dpmpp_3m_sde",
  "dpm++ sde": "dpmpp_sde", "dpm++ 2s a": "dpmpp_2s_ancestral", dpm2: "dpm_2", "dpm2 a": "dpm_2_ancestral",
  unipc: "uni_pc", "dpm fast": "dpm_fast", "dpm adaptive": "dpm_adaptive",
  "euler cfg++": "euler_cfg_pp", "euler a cfg++": "euler_ancestral_cfg_pp",
};
const A1111_SCHEDULERS = {
  karras: "karras", exponential: "exponential", normal: "normal", simple: "simple",
  "sgm uniform": "sgm_uniform", beta: "beta", ddim: "ddim_uniform", "kl optimal": "kl_optimal",
};
// Keys that mean nothing here (they describe the other program), not worth a warning.
const A1111_QUIET = new Set(["RNG", "Version", "Model hash", "VAE hash", "Hires Module 1", "Lora hashes",
  "TI hashes", "Emphasis", "Schedule type", "Hires sampler", "Hires schedule type", "Hires prompt",
  "Hires negative prompt", "Hires CFG Scale", "Hires steps", "Hires upscale", "Hires upscaler",
  "Hires resize-1", "Hires resize-2", "Denoising strength", "Original Size", "width", "height", "Size",
  "Steps", "CFG scale", "Sampler", "Seed", "Model", "Clip skip", "Hashes", "Created Date", "Civitai resources",
  "Civitai metadata", "Downcast alphas_cumprod", "Pad conds", "Pad conds v0", "Beta schedule alpha",
  "Beta schedule beta"]);

function parseParams(text) {
  const lines = text.replace(/\r/g, "").trim().split("\n");
  let i = lines.length - 1;
  while (i >= 0 && !/^\s*Steps:\s*\d+/.test(lines[i])) i--;
  const before = (i >= 0 ? lines.slice(0, i) : lines).join("\n");
  const n = before.indexOf("Negative prompt:");
  const params = {};
  const line = i >= 0 ? lines.slice(i).join(", ") : "";
  for (const m of line.matchAll(/\s*([\w ./+()-]+?):\s*("(?:\\.|[^\\"])*"|[^,]*)(?:,|$)/g)) {
    let v = m[2].trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* keep as is */ } }
    params[m[1].trim()] = v;
  }
  return {
    prompt: (n >= 0 ? before.slice(0, n) : before).trim(),
    negative: n >= 0 ? before.slice(n + "Negative prompt:".length).trim() : "",
    params,
  };
}

function applyParams(text) {
  const { prompt: rawPrompt, negative: rawNegative, params: p } = parseParams(text);
  const done = [], skipped = [];
  const num = (k) => (p[k] !== undefined && p[k] !== "" && !Number.isNaN(+p[k]) ? +p[k] : null);
  const d = S.draft;

  // Model: by file name, title or key.
  let m = model();
  if (p.Model) {
    const want = String(p.Model).toLowerCase().replace(/\.(safetensors|ckpt|gguf)$/, "");
    const found = S.catalog.models.find((x) => x.key === want || x.title.toLowerCase() === want
      || (x.files || []).some((f) => f.toLowerCase().replace(/\.[^.]+$/, "") === want));
    // Not ours: the closest model of the same family (SDXL anime → WAI, Anima, FLUX).
    const family = /flux/.test(want) ? "flux" : /anima(?!gine)/.test(want) ? "anima"
      : /illustrious|noob|pony|animagine|sdxl|xl/.test(want) ? "illustrious" : null;
    const near = !found && family && S.catalog.models.find((x) => x.family === family);
    if (found) {
      m = found;
      done.push(`модель ${found.title}`);
    } else if (near) {
      m = near;
      skipped.push(`модели «${p.Model}» у нас нет — взял похожую: ${near.title}`);
    } else skipped.push(`модель «${p.Model}» — её у нас нет, осталась ${m.title}`);
  }
  d.model = m.key;
  const md = mode();

  const saved = store.get("settings:" + m.key, {});
  const base = (md === "edit" && m.edit_params) || m.params;
  // The pasted prompt already has its quality tags and negative: ours would double them.
  const next = { ...saved, quality: false };
  if (m.tags) done.push("теги качества выключены (они уже в промпте)");
  if (num("Steps")) { next.steps = num("Steps"); done.push(`${next.steps} шагов`); }
  if (num("CFG scale") != null) {
    next.cfg = num("CFG scale");
    done.push(`CFG ${next.cfg}`);
    if (base.cfg === 1 && next.cfg !== 1) skipped.push(`у ${m.title} CFG должен быть 1 — поставил ${next.cfg}, как в параметрах; лучше вернуть 1`);
  }

  // Sampler; old A1111 names carry the scheduler: "DPM++ 2M Karras".
  let name = String(p.Sampler || "").toLowerCase().trim();
  let sch = null;
  for (const s of ["karras", "exponential"]) {
    if (name.endsWith(" " + s)) { name = name.slice(0, -s.length - 1); sch = s; }
  }
  const has = (list, x) => !list.length || list.includes(x);
  const sampler = A1111_SAMPLERS[name];
  if (sampler && has(S.catalog.samplers, sampler)) {
    next.sampler = sampler;
    done.push(`сэмплер ${p.Sampler} → ${sampler}`);
  } else if (p.Sampler) skipped.push(`сэмплер «${p.Sampler}» — в ComfyUI нет такого`);
  const type = String(p["Schedule type"] || "").toLowerCase();
  if (type && type !== "automatic") sch = A1111_SCHEDULERS[type] || null;
  // «Automatic» in A1111: Karras for the DPM++ family, the plain schedule for the rest.
  if (!sch && (sampler || type === "automatic")) sch = (sampler || "").startsWith("dpmpp") ? "karras" : "normal";
  if (sch && has(S.catalog.schedulers, sch)) {
    next.scheduler = sch;
    done.push(`планировщик ${sch}`);
  } else if (type && type !== "automatic") skipped.push(`планировщик «${p["Schedule type"]}»`);

  // Hires fix.
  if (p["Hires upscale"] || p["Hires resize-1"]) {
    if (hiresWorks(m, md)) {
      let scale = num("Hires upscale") || 1.5;
      if (scale > 2) skipped.push(`hires ×${scale} — у нас не больше ×2`);
      scale = Math.min(Math.max(scale, 1.1), 2);
      next.hires = {
        on: true, scale,
        denoise: num("Denoising strength") ?? 0.5,
        steps: num("Hires steps") || next.steps || base.steps, // 0 in A1111 = as many as the first pass
        cfg: num("Hires CFG Scale") ?? "",
      };
      done.push(`hires ×${String(scale).replace(".", ",")}, сила ${next.hires.denoise}, ${next.hires.steps} шагов` +
        (next.hires.cfg !== "" ? `, CFG ${next.hires.cfg}` : ""));
      const up = String(p["Hires upscaler"] || "");
      if (up && !/RealESRGAN_x4plus_anime_6B/i.test(up)) skipped.push(`апскейлер «${up}» — у нас RealESRGAN anime 6B`);
    } else skipped.push(`hires fix — у ${m.title} его нет`);
  } else {
    next.hires = { ...hiresDefaults(m), ...(saved.hires || {}), on: false };
  }

  // LoRA from the prompt: <lora:name:0.8> (ComfyUI does not read this syntax).
  let promptText = rawPrompt;
  const loras = [];
  for (const [all, file, w] of rawPrompt.matchAll(/<lora:([^:>]+)(?::([\d.]+))?[^>]*>/gi)) {
    promptText = promptText.replace(all, "");
    const l = S.catalog.loras.find((x) => x.file.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "").toLowerCase() === file.toLowerCase());
    if (l) {
      loras.push({ file: l.file, on: true, strength: w ? +w : l.strength });
      done.push(`LoRA ${l.title}`);
    } else skipped.push(`LoRA «${file}» — её нет в ComfyUI`);
  }
  promptText = promptText.replace(/[ \t]*,[ \t]*,/g, ",").trim();
  next.loras = loras;
  store.set("settings:" + m.key, next);

  // Size (the first pass; with hires the result is bigger).
  const size = String(p.Size || p["Original Size"] || "").match(/(\d+)\s*x\s*(\d+)/);
  let w = size ? +size[1] : num("width"), hh = size ? +size[2] : num("height");
  if (w && hh) {
    if (md === "text") {
      const r = (v) => Math.min(2048, Math.max(512, Math.round(v / 64) * 64));
      if (r(w) !== w || r(hh) !== hh) skipped.push(`размер ${w}×${hh} — округлил до ${r(w)}×${r(hh)} (кратно 64)`);
      d.size = { w: r(w), h: r(hh) };
      d.kind = "other"; // the prompt is complete: no preset text on top
      done.push(`размер ${d.size.w}×${d.size.h}`);
    } else skipped.push("размер — с картинкой он берётся от картинки");
  }
  if (md !== "text") d.action = null;
  if (md === "img2img" && !next.hires?.on && num("Denoising strength") != null) {
    d.denoise = num("Denoising strength");
    done.push(`сила изменений ${d.denoise}`);
  }
  if (p.Seed !== undefined && p.Seed !== "") { d.seed = String(p.Seed); done.push(`seed ${d.seed}`); }
  d.count = 1;

  const clip = num("Clip skip");
  if (clip && clip !== (m.params.clip_skip || 1)) skipped.push(`Clip skip ${clip} — у ${m.title} ${m.params.clip_skip || 1}`);
  const extra = Object.keys(p).filter((k) => !A1111_QUIET.has(k));
  if (extra.some((k) => /^ADetailer/.test(k))) skipped.push("ADetailer (перерисовка лиц) — у нас нет");
  const other = extra.filter((k) => !/^ADetailer/.test(k));
  if (other.length) skipped.push(other.join(", "));

  let positive = promptText, negative = rawNegative;
  if (m.tags) { positive = a1111Weights(positive); negative = a1111Weights(negative); }
  if (positive !== promptText || negative !== rawNegative) done.push("веса [x] → (x:0.91)");
  if (negative && !m.negative_works) {
    skipped.push(`негатив — ${m.title} его не понимает`);
    negative = "";
  }
  done.unshift("промпт" + (negative ? " и негатив" : ""));
  setPrompt(positive, negative);
  S.importNote = { done, skipped };
  saveDraft();
  refreshComposer();
  toast("Параметры применены — что перенесено, видно под промптом", "info");
}

function openImport() {
  const dlg = $("#import");
  const area = h("textarea", { rows: 10, placeholder: "Например, со страницы картинки на Civitai — «Copy generation data»:\n\n1girl, solo, …\nNegative prompt: bad quality, …\nSteps: 30, CFG scale: 7, Sampler: Euler a, Seed: 123, Size: 1024x1344, …" });
  const error = h("p", { class: "small error hidden" });
  fill(dlg,
    h("div", { class: "modal-head" }, h("h2", {}, "Вставить параметры"), h("button", { class: "icon-btn", onclick: () => dlg.close() }, "✕")),
    h("div", { class: "modal-body" },
      h("p", { class: "small muted" }, "Параметры генерации из Civitai, A1111 или Forge: промпт, негатив и строка «Steps: …». Применятся модель, размер, шаги, CFG, сэмплер, планировщик, seed, hires fix и LoRA; промпт заменится (вернуть — «↶ Вернуть как было»). Можно и просто вставить такой текст в поле промпта."),
      area, error),
    h("div", { class: "modal-foot row" }, h("span", { class: "spacer" }),
      h("button", {
        class: "btn primary",
        onclick: () => {
          if (!looksLikeParams(area.value)) {
            error.textContent = "Не вижу строки «Steps: …, CFG scale: …» — это не параметры A1111/Civitai.";
            error.classList.remove("hidden");
            return;
          }
          dlg.close();
          applyParams(area.value);
        },
      }, "Применить")));
  dlg.showModal();
  area.focus();
}

// Paste into the prompt: full generation parameters are applied, A1111 weights converted.
function pastePrompt(e) {
  const text = e.clipboardData?.getData("text") || "";
  if (e.target === S.ui.prompt && looksLikeParams(text)) {
    e.preventDefault();
    applyParams(text);
    return;
  }
  pasteWeights(e);
}

// A1111/Forge prompts (Civitai) write weaker words as [word]; ComfyUI has no such syntax, so a
// pasted prompt is converted: [x] → (x:0.91), [[x]] → (x:0.83). The server does the same.
function a1111Weights(text) {
  return text.replace(/(?<!\\)(\[+)([^\[\]:|]+?)(\]+)/g, (all, l, body, r) => {
    const n = Math.min(l.length, r.length);
    return `${l.slice(n)}(${body.trim()}:${+(1 / 1.1 ** n).toFixed(2)})${r.slice(n)}`;
  });
}

function pasteWeights(e) {
  if (!model().tags) return;
  const text = e.clipboardData?.getData("text") || "";
  const converted = a1111Weights(text);
  if (converted === text) return;
  e.preventDefault();
  const t = e.target;
  t.setRangeText(converted, t.selectionStart, t.selectionEnd, "end");
  t.dispatchEvent(new Event("input"));
  toast("Веса из A1111 переведены для ComfyUI: [x] → (x:0.91)", "info");
}

// --- AI helper ------------------------------------------------------------------------------

const SETTING_NAMES = { steps: "шаги", cfg: "CFG", denoise: "сила изменений", count: "картинок" };

function renderAssistant() {
  if (!S.catalog.claude) return;
  const tip = S.draft.tip;
  const m = model();
  const sets = tip && tip.model === m.key ? Object.entries(tip.settings || {}) : [];
  fill(S.ui.assistantOut,
    h("div", { class: "row" },
      h("button", {
        class: "btn", disabled: S.assisting || !S.draft.wish.trim(), onclick: runAssistant,
      }, S.assisting ? "Claude думает…" : "Заполнить промпт")),
    tip && tip.text && h("div", { class: "tip" },
      h("p", {}, tip.text),
      sets.length > 0 && h("div", { class: "row" },
        h("span", { class: "small" }, "Настройки: ",
          h("b", {}, sets.map(([k, v]) => `${SETTING_NAMES[k] || k} ${String(v).replace(".", ",")}`).join(" · "))),
        tip.applied
          ? h("span", { class: "small muted" }, "✓ применено")
          : h("button", { class: "link", onclick: applyTip }, "Применить")),
      h("button", { class: "link small-link", onclick: () => { S.draft.tip = null; saveDraft(); renderAssistant(); } }, "Скрыть")));
}

async function runAssistant() {
  const wish = S.draft.wish.trim();
  if (!wish) return;
  const m = model();
  const md = mode();
  const st = settingsFor(m);
  const current = { steps: st.steps, cfg: st.cfg, count: S.draft.count };
  if (md === "img2img") current.denoise = denoiseNow();
  S.assisting = true;
  renderAssistant();
  try {
    const res = await api("/api/assistant", {
      body: { wish, model: m.key, images: S.draft.images, preset: preset()?.id || null, settings: current },
    });
    setPrompt(res.prompt || "", m.negative_works ? res.negative || "" : undefined);
    S.draft.tip = { text: res.tip, settings: res.settings || {}, model: m.key, applied: false };
    saveDraft();
  } catch (e) {
    toast(e.message);
  } finally {
    S.assisting = false;
    renderAssistant();
  }
}

function applyTip() {
  const tip = S.draft.tip;
  const s = tip.settings || {};
  if (s.count) S.draft.count = s.count;
  if (s.denoise != null) S.draft.denoise = s.denoise;
  const keep = {};
  if (s.steps) keep.steps = s.steps;
  if (s.cfg != null) keep.cfg = s.cfg;
  if (Object.keys(keep).length) {
    store.set("settings:" + tip.model, { ...store.get("settings:" + tip.model, {}), ...keep });
  }
  tip.applied = true;
  saveDraft();
  refreshComposer();
}

// --- brainstorm -----------------------------------------------------------------------------

function brainstormModels() {
  const keys = S.draft.bsModels || BRAINSTORM_MODELS;
  const list = S.catalog.models.filter((m) => keys.includes(m.key));
  return list.length ? list : S.catalog.models.slice(0, 1);
}

function renderBrainstorm() {
  const d = S.draft;
  if (!S.catalog.claude) {
    fill(S.ui.bsOut, h("p", { class: "small warn" }, "Нужен Claude — на этой машине он недоступен."));
    return;
  }
  const chosen = new Set(brainstormModels().map((m) => m.key));
  const ideas = d.ideas.filter((x) => x.on);
  const total = ideas.length * chosen.size;
  fill(S.ui.bsOut,
    h("div", { class: "row" }, h("span", { class: "small muted" }, "Сколько идей:"),
      h("div", { class: "chips" }, [3, 4, 6].map((n) => chip(String(n), d.bsCount === n, () => {
        d.bsCount = n; saveDraft(); renderBrainstorm();
      })))),
    h("button", { class: "btn", disabled: S.brainstorming, onclick: runBrainstorm },
      S.brainstorming ? "Claude придумывает… (≈ 30–60 с)" : d.ideas.length ? "Придумать заново" : "Придумать идеи"),
    d.ideas.length > 0 && h("div", { class: "ideas" }, d.ideas.map((idea) =>
      h("label", { class: "idea" + (idea.on ? " on" : "") },
        h("input", {
          type: "checkbox", checked: idea.on,
          onchange: (e) => { idea.on = e.target.checked; saveDraft(); renderBrainstorm(); },
        }),
        h("div", {}, h("b", {}, idea.title), h("p", { class: "small" }, idea.description))))),
    d.ideas.length > 0 && field("Модели", h("div", { class: "chips" }, S.catalog.models.map((m) =>
      chip(m.title, chosen.has(m.key), () => {
        const next = new Set(chosen);
        if (next.has(m.key)) next.delete(m.key); else next.add(m.key);
        if (!next.size) return;
        d.bsModels = [...next];
        saveDraft();
        renderBrainstorm();
      })))),
    d.ideas.length > 0 && h("button", { class: "btn primary big", disabled: !total, onclick: drawIdeas },
      total ? `Нарисовать: ${plural(ideas.length, "идея", "идеи", "идей")} × ${plural(chosen.size, "модель", "модели", "моделей")} = ${total}` : "Отметьте идеи"));
}

async function runBrainstorm() {
  S.brainstorming = true;
  renderBrainstorm();
  try {
    const res = await api("/api/brainstorm", {
      body: { task_id: S.task.id, images: S.draft.images, wish: S.draft.bsWish, count: S.draft.bsCount },
    });
    S.draft.ideas = res.ideas.map((x) => ({ ...x, on: true }));
    saveDraft();
  } catch (e) {
    toast(e.message);
  } finally {
    S.brainstorming = false;
    if (isBrainstorm()) renderBrainstorm();
  }
}

async function drawIdeas() {
  const d = S.draft;
  const ideas = d.ideas.map((x, i) => ({ ...x, n: i + 1 })).filter((x) => x.on);
  const models = brainstormModels();
  const batch = Math.random().toString(36).slice(2, 10);
  const size = S.catalog.sizes.portrait;
  let queued = 0;
  // Model by model, so each model loads once.
  for (const m of models) {
    for (const idea of ideas) {
      try {
        await api("/api/jobs", {
          body: {
            task_id: S.task.id, model: m.key, images: [], preset: "character", white_bg: d.white_bg,
            prompt: m.tags ? idea.tags : idea.text, negative: "",
            settings: { ...jobSettings(m, "text"), hires: null, count: 1, seed: "", width: size.width, height: size.height },
            idea: { batch, n: idea.n, title: idea.title, description: idea.description, source: d.images[0] },
          },
        });
        queued++;
      } catch (e) {
        toast(e.message);
        break;
      }
    }
  }
  if (queued) toast(`В очереди ${plural(queued, "картинка", "картинки", "картинок")}`, "info");
  await pollStatus();
  if (window.innerWidth < 1100) S.ui.jobs.scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- settings window ------------------------------------------------------------------------

function openSettings() {
  const dlg = $("#settings");
  const m = model();
  const md = mode();
  const st = settingsFor(m);
  const base = (md === "edit" && m.edit_params) || m.params;
  const d = S.draft;
  let reset = false;

  const count = h("div", { class: "chips" }, [1, 2, 3, 4].map((n) =>
    chip(String(n), d.count === n, (e) => {
      d.count = n;
      count.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === e.currentTarget));
    })));

  let size = null;
  if (md === "text") {
    const cur = sizeNow();
    const sizes = Object.values(S.catalog.sizes);
    const w = h("input", { type: "number", min: 512, max: 2048, step: 64, value: cur.w });
    const hh = h("input", { type: "number", min: 512, max: 2048, step: 64, value: cur.h });
    const chips = h("div", { class: "chips" }, sizes.map((s) =>
      chip(s.title, s.width === cur.w && s.height === cur.h, () => {
        w.value = s.width;
        hh.value = s.height;
        sync();
      })));
    const sync = () => {
      d.size = { w: +w.value, h: +hh.value };
      chips.querySelectorAll(".chip").forEach((c, i) => {
        c.classList.toggle("on", sizes[i].width === d.size.w && sizes[i].height === d.size.h);
      });
    };
    w.oninput = hh.oninput = sync;
    size = field("Размер", h("div", {}, chips, h("div", { class: "row size-row" }, w, "×", hh)), "size");
  }

  let denoise = null;
  if (md === "img2img") {
    const value = h("b", {}, denoiseNow());
    const range = h("input", {
      type: "range", min: 0.05, max: 1, step: 0.05, value: denoiseNow(),
      oninput: (e) => { d.denoise = +e.target.value; value.textContent = d.denoise; },
    });
    denoise = field("Сила изменений", h("div", { class: "row" }, range, value), "denoise");
  }

  const steps = h("input", { type: "number", min: 1, max: 150, value: st.steps });
  const cfg = h("input", { type: "number", min: 0, max: 30, step: 0.1, value: st.cfg });
  const options = (list, current) => {
    const names = list.length ? list : [current];
    return h("select", {}, names.map((n) => h("option", { value: n, selected: n === current }, n)));
  };
  const sampler = options(S.catalog.samplers, st.sampler);
  const scheduler = options(S.catalog.schedulers, st.scheduler);
  const seed = h("input", { type: "number", min: 0, placeholder: "случайный", value: d.seed ?? "" });
  const quality = m.tags ? h("input", { type: "checkbox", checked: st.quality !== false }) : null;
  // Hires fix block.
  let hiresBox = null, hiresRead = null;
  if (hiresWorks(m, md)) {
    const hs = st.hires;
    const def = hiresDefaults(m);
    let scale = hs.scale;
    const on = h("input", { type: "checkbox", checked: hs.on });
    const final = h("span", { class: "small muted" });
    const showFinal = () => {
      if (md === "text") {
        const b = d.size || sizeNow();
        const f = hiresSize(b.w, b.h, scale);
        final.textContent = `итог ${f.w}×${f.h}`;
      } else final.textContent = "от размера картинки";
    };
    const scales = h("div", { class: "chips" }, [1.5, 2].map((x) => chip(`×${String(x).replace(".", ",")}`, scale === x, (e) => {
      scale = x;
      scales.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === e.currentTarget));
      showFinal();
    })));
    const dnValue = h("b", {}, hs.denoise);
    const dn = h("input", {
      type: "range", min: 0.2, max: 0.8, step: 0.05, value: hs.denoise,
      oninput: (e) => { dnValue.textContent = e.target.value; },
    });
    const hSteps = h("input", { type: "number", min: 1, max: 60, value: hs.steps });
    const hCfg = h("input", { type: "number", min: 0, max: 30, step: 0.1, value: hs.cfg, placeholder: `как основной (${st.cfg})` });
    const ups = S.catalog.upscalers || [];
    const upNote = (f) => UPSCALER_NOTES[f] || "";
    const upHint = h("span", { class: "small muted" }, upNote(hs.upscaler || DEFAULT_UPSCALER));
    const upscaler = ups.length > 1 ? h("select", { onchange: (e) => { upHint.textContent = upNote(e.target.value); } },
      ups.map((f) => h("option", { value: f, selected: f === (hs.upscaler || DEFAULT_UPSCALER) }, f.replace(/\.(pth|safetensors)$/, "")))) : null;
    showFinal();
    hiresRead = () => ({
      on: on.checked, scale, denoise: +dn.value, steps: +hSteps.value || def.steps,
      upscaler: upscaler ? upscaler.value : hs.upscaler || "",
      cfg: hCfg.value === "" ? "" : +hCfg.value,
    });
    hiresBox = field("Hires fix — второй проход", h("div", { class: "hires" },
      h("label", { class: "check" }, on, "Включить"),
      h("div", { class: "row" }, h("span", { class: "small" }, "Увеличить"), scales, final),
      upscaler && h("label", { class: "small" }, "Апскейлер", upscaler, upHint),
      h("div", { class: "row" }, h("span", { class: "small" }, "Сила"), dn, dnValue),
      h("div", { class: "grid-2" },
        h("label", { class: "small" }, "Шаги второго прохода", hSteps),
        h("label", { class: "small" }, "CFG второго прохода", hCfg))), "hires");
  }

  dlg.onclose = () => {
    if (!reset) {
      store.set("settings:" + m.key, {
        steps: +steps.value || base.steps,
        cfg: cfg.value === "" ? base.cfg : +cfg.value,
        sampler: sampler.value, scheduler: scheduler.value,
        quality: quality ? quality.checked : true,
        loras: store.get("settings:" + m.key, {}).loras || [], // edited in the LoRA block
        hires: hiresRead ? hiresRead() : st.hires,
      });
      d.seed = seed.value;
    }
    saveDraft();
    refreshComposer();
  };

  fill(dlg, 
    h("div", { class: "modal-head" }, h("h2", {}, m.title), h("button", { class: "icon-btn", onclick: () => dlg.close() }, "✕")),
    h("div", { class: "modal-body" },
      h("p", { class: "small muted" }, "Под каждой настройкой — что она делает и какое значение стандартное для этой модели. Не уверены — оставьте как есть или нажмите «Сбросить»."),
      field("Сколько картинок", count, "count"),
      size, denoise,
      field("Шаги", steps, "steps"),
      field("CFG", cfg, "cfg"),
      field("Сэмплер", sampler, "sampler"),
      field("Планировщик", scheduler, "scheduler"),
      field("Seed", seed, "seed"),
      hiresBox,
      quality && field("Теги качества", h("label", { class: "check" }, quality, "Включены",
        h("span", { class: "small muted" }, ` (${m.prefix.replace(/,\s*$/, "")})`)), "quality"),
      lorasFor(m).length > 0 && h("p", { class: "small muted" }, "LoRA включаются в блоке «LoRA» под выбором модели.")),
    h("div", { class: "modal-foot row" },
      h("button", {
        class: "link",
        onclick: () => {
          reset = true;
          store.set("settings:" + m.key, {});
          Object.assign(d, { count: 1, seed: "", size: null, denoise: null });
          dlg.close();
        },
      }, "Сбросить"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn primary", onclick: () => dlg.close() }, "Готово")));
  dlg.showModal();
}

// --- help window: how this model works and how to write for it ----------------------------

function openHelp() {
  const dlg = $("#help");
  const m = model();
  const help = S.catalog.help || {};
  const family = (help.families || {})[m.family] || {};
  let tab = S.draft.images.length ? "picture" : "text";
  const body = h("div", { class: "modal-body help" });

  const tabs = h("div", { class: "chips" }, [["text", "Без картинки"], ["picture", "С картинкой"]].map(([key, title]) =>
    chip(title, tab === key, (e) => {
      tab = key;
      tabs.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === e.currentTarget));
      draw();
    })));

  function draw() {
    const sec = family[tab];
    if (!sec) {
      fill(body, tabs, h("p", { class: "muted" }, "Подсказки для этой модели пока нет."));
      return;
    }
    fill(body,
      tabs,
      h("p", { class: "help-how" }, sec.how),
      h("div", {},
        h("h3", {}, "Как писать промпт"),
        h("ul", {}, (sec.write || []).map((line) => h("li", {}, line)))),
      sec.example && h("div", {},
        h("h3", {}, "Пример"),
        h("p", { class: "help-example" }, sec.example),
        h("button", {
          class: "link",
          onclick: () => {
            setPrompt(sec.example, undefined); // «Вернуть как было» brings the old prompt back
            dlg.close();
          },
        }, "Вставить пример в промпт")),
      sec.negative && h("div", {}, h("h3", {}, "Негатив"), h("p", {}, sec.negative)),
      ((help.models || {})[m.key] || []).length > 0 && h("div", {},
        h("h3", {}, m.title),
        h("ul", {}, help.models[m.key].map((line) => h("li", {}, line)))));
  }

  draw();
  fill(dlg,
    h("div", { class: "modal-head" }, h("h2", {}, `Подсказка: ${m.title}`),
      h("button", { class: "icon-btn", onclick: () => dlg.close() }, "✕")),
    body,
    h("div", { class: "modal-foot row" }, h("span", { class: "spacer" }),
      h("button", { class: "btn primary", onclick: () => dlg.close() }, "Понятно")));
  dlg.showModal();
}

// A form field; helpKey adds the explanation from help.json → settings (and the model's line).
function field(label, control, helpKey) {
  const help = helpKey && ((S.catalog.help || {}).settings || {})[helpKey];
  const note = help && (help.models || {})[model().key];
  return h("div", { class: "field" }, h("label", { class: "label" }, label), control,
    help && help.text && h("p", { class: "small muted field-help" }, help.text),
    note && h("p", { class: "small field-note" }, `${model().title}: ${note}`));
}

// --- generate -------------------------------------------------------------------------------

// The model's settings as /api/jobs takes them.
function jobSettings(m, md = mode()) {
  const st = settingsFor(m, md);
  return {
    steps: st.steps, cfg: st.cfg, sampler: st.sampler, scheduler: st.scheduler,
    quality: st.quality !== false,
    loras: (st.loras || []).filter((l) => l.on && S.catalog.loras.some((x) => x.file === l.file))
      .map((l) => ({ file: l.file, strength: l.strength, ...(l.variant ? { variant: l.variant } : {}) })),
    hires: st.hires.on && hiresWorks(m, md)
      ? { scale: st.hires.scale, denoise: st.hires.denoise, steps: st.hires.steps, cfg: st.hires.cfg === "" ? null : st.hires.cfg, upscaler: st.hires.upscaler || "" }
      : null,
  };
}

async function submit() {
  const m = model();
  const md = mode();
  const p = preset();
  const settings = { ...jobSettings(m, md), count: S.draft.count, seed: S.draft.seed ?? "" };
  if (md === "text") Object.assign(settings, { width: sizeNow().w, height: sizeNow().h });
  if (md === "img2img" && S.draft.denoise != null) settings.denoise = S.draft.denoise;
  S.ui.submit.disabled = true;
  try {
    await api("/api/jobs", {
      body: {
        task_id: S.task.id, model: m.key, images: S.draft.images, preset: p ? p.id : null,
        white_bg: S.draft.white_bg, prompt: S.ui.prompt.value,
        negative: m.negative_works ? S.ui.negative.value : "", settings,
      },
    });
    await pollStatus();
    if (window.innerWidth < 1100) S.ui.jobs.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    toast(e.message);
  } finally {
    S.ui.submit.disabled = false;
  }
}

// --- history --------------------------------------------------------------------------------

// History blocks, newest first; pictures of one submission stay in the order they were drawn.
// A brainstorm is one block (all its ideas in all models), ordered by idea.
function historyGroups() {
  const groups = [];
  const keyOf = (it) => (it.type !== "generated" ? null : it.idea?.batch ? "b:" + it.idea.batch : "j:" + it.job);
  for (const it of [...S.task.items].reverse()) {
    const last = groups[groups.length - 1];
    const key = keyOf(it);
    if (key && last && last.key === key) last.items.unshift(it);
    else groups.push({ key, items: [it] });
  }
  for (const g of groups) {
    if (g.key?.startsWith("b:")) g.items.sort((a, b) => (a.idea.n || 0) - (b.idea.n || 0) || a.time.localeCompare(b.time));
  }
  return groups;
}

function renderHistory() {
  const groups = historyGroups();
  fill(S.ui.history, groups.length
    ? groups.map((g) => (!g.key ? uploadEntry(g.items[0]) : g.key.startsWith("b:") ? brainstormEntry(g.items) : jobEntry(g.items)))
    : h("p", { class: "muted empty" }, "Здесь появятся картинки."));
}

function brainstormEntry(items) {
  const first = items[0];
  const src = first.idea.source;
  const ideas = new Set(items.map((i) => i.idea.n)).size;
  return h("article", { class: "entry" },
    h("div", { class: "entry-head" },
      h("b", {}, "Мозговой штурм"),
      h("span", { class: "pill" }, plural(ideas, "идея", "идеи", "идей")),
      h("span", { class: "spacer" }),
      h("span", { class: "small muted" }, timeText(first.time))),
    src && item(src) && h("div", { class: "entry-inputs" },
      h("button", { class: "mini", onclick: () => openViewer(src) }, h("img", { src: thumbUrl(src, 160), alt: "" }))),
    h("div", { class: "grid" }, items.map((it) =>
      h("button", { class: "tile captioned", onclick: () => openViewer(it.file) },
        h("img", { src: thumbUrl(it.file, 640), alt: "", loading: "lazy" }),
        h("span", { class: "tile-cap" }, h("b", {}, it.idea.title), h("span", {}, it.model_title))))));
}

function jobEntry(items) {
  const first = items[0];
  return h("article", { class: "entry" },
    h("div", { class: "entry-head" },
      h("b", {}, first.model_title || first.model),
      first.preset_title && h("span", { class: "pill" }, first.preset_title),
      h("span", { class: "spacer" }),
      h("span", { class: "small muted" }, timeText(first.time))),
    (first.inputs || []).length > 0 && h("div", { class: "entry-inputs" },
      first.inputs.map((f) => h("button", { class: "mini", onclick: () => openViewer(f) },
        h("img", { src: thumbUrl(f, 160), alt: "" })))),
    first.prompt && h("p", {
      class: "entry-prompt clamp", onclick: (e) => e.currentTarget.classList.toggle("clamp"),
    }, first.prompt),
    h("div", { class: "grid" }, items.map((it) =>
      h("button", { class: "tile", onclick: () => openViewer(it.file) },
        h("img", { src: thumbUrl(it.file, 640), alt: "", loading: "lazy" })))));
}

function uploadEntry(it) {
  return h("article", { class: "entry upload" },
    h("div", { class: "upload-row" },
      h("button", { class: "tile", onclick: () => openViewer(it.file) },
        h("img", { src: thumbUrl(it.file, 320), alt: "", loading: "lazy" })),
      h("div", {},
        h("div", { class: "entry-head" }, h("b", {}, "Картинка"), h("span", { class: "spacer" }),
          h("span", { class: "small muted" }, timeText(it.time))),
        analysisView(it, false),
        !S.draft.images.includes(it.file) && h("button", {
          class: "link", title: "Прикрепить к следующей генерации", onclick: () => attach(it.file),
        }, "Доработать"))));
}

// Job cards are built once and updated in place: rebuilding them every second would swallow
// taps on «✕».
const jobCards = new Map();
const failedCards = new Map();

function renderTaskJobs() {
  if (S.view !== "task" || !S.ui) return;
  const jobs = (S.status?.active || []).filter((j) => j.task_id === S.task.id);
  const failed = (S.status?.finished || []).filter((j) => j.task_id === S.task.id && j.status === "error"
    && Date.now() / 1000 - j.finished < 120);
  const nodes = failed.map((j) => {
    if (!failedCards.has(j.id)) {
      failedCards.set(j.id, h("div", { class: "entry job error" }, h("b", {}, "Не получилось: "), j.error));
    }
    return failedCards.get(j.id);
  });
  for (const j of jobs) {
    let c = jobCards.get(j.id);
    if (!c) {
      c = { stage: h("span", { class: "small muted" }), eta: h("span", { class: "small" }), bar: h("i"),
        done: h("p", { class: "small muted" }) };
      c.el = h("div", { class: "entry job" },
        h("div", { class: "entry-head" }, h("b", {}, j.model_title), c.stage, h("span", { class: "spacer" }), c.eta,
          h("button", { class: "icon-btn", title: "Отменить", onclick: () => cancelJob(j.id) }, "✕")),
        h("div", { class: "bar" }, c.bar), c.done);
      jobCards.set(j.id, c);
    }
    c.stage.textContent = j.status === "queued" ? "в очереди" : j.stage;
    c.eta.textContent = "≈ " + seconds(liveEta(j));
    c.bar.style.width = `${Math.round(j.progress * 100)}%`;
    c.done.textContent = j.count > 1 ? `готово ${j.done} из ${j.count}` : "";
    nodes.push(c.el);
  }
  const ids = new Set(jobs.map((j) => j.id));
  for (const id of [...jobCards.keys()]) if (!ids.has(id)) jobCards.delete(id);
  const current = [...S.ui.jobs.children];
  if (current.length !== nodes.length || current.some((n, i) => n !== nodes[i])) {
    fill(S.ui.jobs, ...nodes);
  }
}

// --- viewer ---------------------------------------------------------------------------------

function openViewer(file) {
  const dlg = $("#viewer");
  const list = historyGroups().flatMap((g) => g.items.map((i) => i.file));
  let index = Math.max(0, list.indexOf(file));
  const step = (d) => { index = (index + d + list.length) % list.length; show(); };

  function show() {
    const f = list[index];
    const it = item(f) || { file: f };
    const info = it.type === "generated"
      ? [
        it.idea && h("p", {}, h("b", {}, it.idea.title), it.idea.description ? " — " + it.idea.description : ""),
        h("p", {}, h("b", {}, it.model_title), it.preset_title ? ` · ${it.preset_title}` : "",
          ` · seed ${it.seed}`, it.size ? ` · ${it.size[0]}×${it.size[1]}` : "",
          it.seconds ? ` · ${seconds(it.seconds)}` : ""),
        it.prompt && h("p", { class: "small" }, it.prompt),
        it.negative && h("p", { class: "small muted" }, "Негатив: " + it.negative),
      ]
      : [analysisView(it, false)];
    const img = h("img", { src: fileUrl(f), alt: "", draggable: "false" });
    const box = h("div", { class: "viewer-img" },
      list.length > 1 && h("button", { class: "nav prev", onclick: () => step(-1) }, "‹"),
      img,
      list.length > 1 && h("button", { class: "nav next", onclick: () => step(1) }, "›"));
    zoomable(box, img, (d) => list.length > 1 && step(d));
    fill(dlg,
      h("div", { class: "viewer-top" },
        h("span", { class: "small" }, `${index + 1} / ${list.length}`),
        h("span", { class: "small muted zoom-hint" }, "приблизить — двумя пальцами или двойным касанием"),
        h("span", { class: "spacer" }),
        h("button", { class: "icon-btn", onclick: () => dlg.close() }, "✕")),
      box,
      h("div", { class: "viewer-info" }, info),
      h("div", { class: "row viewer-actions" },
        h("a", { class: "btn", href: fileUrl(f) + "?download=1", download: "" }, "Скачать"),
        h("button", {
          class: "btn", title: "Прикрепить к следующей генерации",
          onclick: () => { dlg.close(); attach(f); },
        }, "Доработать")));
  }

  dlg.onkeydown = (e) => {
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  };
  show();
  dlg.showModal();
}

// Pinch, double tap and wheel zoom the picture itself (not the page); drag moves a zoomed
// picture. A horizontal swipe turns pages only when the picture is not zoomed and only one
// finger touched it.
function zoomable(box, img, onSwipe) {
  let s = 1, tx = 0, ty = 0;
  const pts = new Map();
  let pinch = null, pan = null, swipe = null, multi = false, lastTap = null;

  const apply = (smooth) => {
    img.style.transition = smooth ? "transform 0.2s ease-out" : "none";
    img.style.transform = s === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${s})`;
    box.classList.toggle("zoomed", s > 1);
  };
  const clamp = () => {
    s = Math.min(Math.max(s, 1), 8);
    if (s < 1.03) { s = 1; tx = ty = 0; return; }
    const mx = Math.max(0, (img.offsetWidth * s - box.clientWidth) / 2);
    const my = Math.max(0, (img.offsetHeight * s - box.clientHeight) / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  };
  // Point relative to the centre of the box (= centre of the unzoomed picture).
  const at = (x, y) => {
    const r = box.getBoundingClientRect();
    return [x - r.left - r.width / 2, y - r.top - r.height / 2];
  };
  // Zoom to `ns` keeping the picture point under (cx, cy) in place.
  const zoomTo = (ns, [cx, cy], from = { s, tx, ty }, to = [cx, cy]) => {
    const px = (cx - from.tx) / from.s, py = (cy - from.ty) / from.s;
    s = Math.min(Math.max(ns, 1), 8);
    tx = to[0] - px * s;
    ty = to[1] - py * s;
    clamp();
  };
  const two = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) };
  };

  box.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      multi = true;
      pinch = { ...two(), s, tx, ty };
      pan = null;
    } else if (pts.size === 1) {
      multi = false;
      pan = { x: e.clientX, y: e.clientY, tx, ty };
      swipe = { x: e.clientX, y: e.clientY };
    }
  });
  box.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size >= 2 && pinch) {
      const now = two();
      zoomTo(pinch.s * now.d / pinch.d, pinch.c, pinch, now.c);
      apply(false);
    } else if (pts.size === 1 && pan && s > 1) {
      tx = pan.tx + e.clientX - pan.x;
      ty = pan.ty + e.clientY - pan.y;
      clamp();
      apply(false);
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 1) { // one finger left after a pinch: go on moving the picture
      const [p] = [...pts.values()];
      pan = { x: p[0], y: p[1], tx, ty };
      pinch = null;
      return;
    }
    if (pts.size) return;
    pinch = null;
    if (!multi && swipe && e.type === "pointerup") {
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      if (s === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        onSwipe(dx < 0 ? 1 : -1);
      } else if (Math.hypot(dx, dy) < 10) { // a tap; two quick taps zoom in or back out
        const t = Date.now();
        if (lastTap && t - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          if (s > 1) { s = 1; tx = ty = 0; } else zoomTo(2.5, at(e.clientX, e.clientY));
          apply(true);
          lastTap = null;
        } else {
          lastTap = { t, x: e.clientX, y: e.clientY };
        }
      }
    }
    swipe = null;
  };
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", up);
  box.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomTo(s * Math.exp(-e.deltaY * 0.0025), at(e.clientX, e.clientY));
    apply(false);
  }, { passive: false });
}

// Safari (iPad) zooms the whole page on pinch even with touch-action: stop it while the
// viewer is open.
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (e) => { if ($("#viewer").open) e.preventDefault(); }, { passive: false });
}

// --- queue bar ------------------------------------------------------------------------------

let statusTimer = null;
let activeIds = new Set();

async function pollStatus() {
  clearTimeout(statusTimer);
  try {
    S.status = await api("/api/status");
    S.statusAt = Date.now();
  } catch { /* keep the last status */ }
  const active = S.status?.active || [];
  const ids = new Set(active.map((j) => j.id));
  const ended = [...activeIds].some((id) => !ids.has(id));
  activeIds = ids;
  if (ended && S.view === "task") await reloadTask();
  renderQueue();
  renderTaskJobs();
  statusTimer = setTimeout(pollStatus, active.length ? 1500 : 5000);
}

function liveEta(j) {
  return Math.max(0, j.eta - (Date.now() - S.statusAt) / 1000);
}

function renderQueue() {
  const active = S.status?.active || [];
  $("#comfy-off").classList.toggle("hidden", S.status?.comfy !== false);
  $("#queue").classList.toggle("hidden", !active.length);
  if (!active.length) return;
  const j = active[0];
  $("#queue-title").textContent = j.status === "queued"
    ? `В очереди · ${j.task_title}`
    : `${j.stage} · ${j.task_title}${j.count > 1 ? ` · ${Math.min(j.done + 1, j.count)} из ${j.count}` : ""}`;
  $("#queue-time").textContent = "≈ " + seconds(Math.max(0, S.status.total_remaining - (Date.now() - S.statusAt) / 1000));
  $("#queue-bar").style.width = `${Math.round(j.progress * 100)}%`;
  $("#queue-more").textContent = active.length > 1 ? `ещё в очереди: ${active.length - 1}` : "";
  $("#queue-cancel").onclick = () => cancelJob(j.id);
}

async function cancelJob(id) {
  try {
    await api(`/api/jobs/${id}`, { method: "DELETE" });
    await pollStatus();
  } catch (e) { toast(e.message); }
}

// Smooth countdown between polls.
setInterval(() => {
  if (!S.status?.active?.length) return;
  renderQueue();
  renderTaskJobs();
}, 1000);

boot();
