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
  helping: false,
};

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
    prompt: "", negative: "", original: null,
    count: 1, seed: "", size: null, denoise: null,
    ...saved,
  };
  if (!S.catalog.models.some((m) => m.key === d.model)) d.model = S.catalog.models[0].key;
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

function settingsFor(m) {
  const base = (mode() === "edit" && m.edit_params) || m.params;
  return {
    steps: base.steps, cfg: base.cfg, sampler: base.sampler, scheduler: base.scheduler,
    quality: true, loras: [],
    ...store.get("settings:" + m.key, {}),
  };
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
  failedCards.clear();
  const ui = (S.ui = {});

  ui.title = h("h1", { class: "task-title" }, S.task.title);
  ui.attach = h("section", { class: "block attach" });
  ui.presets = h("section", { class: "block" });
  ui.model = h("section", { class: "block" });
  ui.prompt = h("textarea", {
    rows: 4, value: S.draft.prompt,
    oninput: () => { S.draft.prompt = ui.prompt.value; S.draft.original = null; saveDraft(); renderPromptTools(); },
  });
  ui.promptTools = h("div", { class: "row prompt-tools" });
  ui.negative = h("textarea", {
    rows: 2, value: S.draft.negative,
    oninput: () => { S.draft.negative = ui.negative.value; saveDraft(); },
  });
  ui.negativeBox = h("details", { class: "negative", open: !!S.draft.negative },
    h("summary", {}, "Негативный промпт"), ui.negative);
  ui.submit = h("button", { class: "btn primary big", onclick: submit }, "Нарисовать");
  ui.jobs = h("div", { class: "task-jobs" });
  ui.history = h("div", { class: "history" });

  const composer = h("div", { class: "composer card" },
    ui.attach, ui.presets, ui.model,
    h("section", { class: "block" }, h("label", { class: "label" }, "Промпт"), ui.prompt, ui.promptTools, ui.negativeBox),
    ui.submit);

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
  renderModel();
  renderPromptTools();
  const m = model();
  S.ui.negativeBox.classList.toggle("hidden", !m.negative_works);
  S.ui.prompt.placeholder = mode() === "text"
    ? "Что нарисовать (можно по-русски)"
    : "Что поменять или добавить (можно по-русски)";
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
  S.draft.original = null;
  saveDraft();
  renderPromptTools();
}

function attach(file) {
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
  let chips;
  if (images) {
    chips = [
      ...S.catalog.actions.map((a) => chip(a.title, S.draft.action === a.id, () => chooseAction(a))),
      chip("Свой промпт", !S.draft.action, () => chooseAction(null)),
    ];
  } else {
    chips = S.catalog.kinds.map((k) => chip(k.title, S.draft.kind === k.id, () => {
      S.draft.kind = k.id;
      S.draft.size = null;
      saveDraft();
      refreshComposer();
    }));
  }
  const key = m.tags ? "tags" : "text";
  const adds = p ? [p[key], p.white_bg && S.draft.white_bg ? S.catalog.white_bg[key] : ""].filter(Boolean) : [];
  fill(S.ui.presets, 
    h("label", { class: "label" }, images ? "Что сделать" : "Что рисуем"),
    h("div", { class: "chips" }, chips),
    p && p.white_bg && h("label", { class: "check" },
      h("input", {
        type: "checkbox", checked: S.draft.white_bg,
        onchange: (e) => { S.draft.white_bg = e.target.checked; saveDraft(); renderPresets(); },
      }), S.catalog.white_bg.title),
    adds.length > 0 && h("p", { class: "adds small muted" }, "Добавится: ", h("span", {}, adds.join(m.tags ? ", " : " "))));
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

// --- prompt helper --------------------------------------------------------------------------

function renderPromptTools() {
  const ui = S.ui;
  fill(ui.promptTools, 
    S.catalog.claude && h("button", {
      class: "btn", disabled: S.helping || !ui.prompt.value.trim(), onclick: helpPrompt,
    }, S.helping ? "Claude переводит…" : "Перевести в промпт"),
    S.draft.original != null && h("button", {
      class: "link",
      onclick: () => {
        ui.prompt.value = S.draft.prompt = S.draft.original;
        S.draft.original = null;
        saveDraft();
        renderPromptTools();
      },
    }, "Вернуть мой текст"));
}

async function helpPrompt() {
  const text = S.ui.prompt.value.trim();
  if (!text) return;
  S.helping = true;
  renderPromptTools();
  try {
    const res = await api("/api/prompt-help", {
      body: { text, model: model().key, images: mode() === "edit" ? S.draft.images.length : 0 },
    });
    if (res.prompt) {
      S.ui.prompt.value = res.prompt;
      S.draft.prompt = res.prompt;
      S.draft.original = text;
      saveDraft();
    }
  } catch (e) {
    toast(e.message);
  } finally {
    S.helping = false;
    renderPromptTools();
  }
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
    size = field("Размер", h("div", {}, chips, h("div", { class: "row size-row" }, w, "×", hh)));
  }

  let denoise = null;
  if (md === "img2img") {
    const value = h("b", {}, denoiseNow());
    const range = h("input", {
      type: "range", min: 0.05, max: 1, step: 0.05, value: denoiseNow(),
      oninput: (e) => { d.denoise = +e.target.value; value.textContent = d.denoise; },
    });
    denoise = field("Сила изменений", h("div", {}, h("div", { class: "row" }, range, value),
      h("p", { class: "small muted" }, "Меньше — ближе к исходной картинке.")));
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
  const loraRows = S.catalog.loras.filter((l) => !l.family || l.family === m.family).map((l) => {
    const cur = (st.loras || []).find((x) => x.file === l.file);
    const strength = cur?.strength ?? l.strength;
    const value = h("span", { class: "small" }, strength);
    return {
      l,
      on: h("input", { type: "checkbox", checked: !!cur?.on }),
      value,
      strength: h("input", {
        type: "range", min: l.range[0], max: l.range[1], step: 0.05, value: strength,
        oninput: (e) => { value.textContent = e.target.value; },
      }),
    };
  });

  dlg.onclose = () => {
    if (!reset) {
      store.set("settings:" + m.key, {
        steps: +steps.value || base.steps,
        cfg: cfg.value === "" ? base.cfg : +cfg.value,
        sampler: sampler.value, scheduler: scheduler.value,
        quality: quality ? quality.checked : true,
        loras: loraRows.map((r) => ({ file: r.l.file, on: r.on.checked, strength: +r.strength.value })),
      });
      d.seed = seed.value;
    }
    saveDraft();
    refreshComposer();
  };

  fill(dlg, 
    h("div", { class: "modal-head" }, h("h2", {}, m.title), h("button", { class: "icon-btn", onclick: () => dlg.close() }, "✕")),
    h("div", { class: "modal-body" },
      field("Сколько картинок", count),
      size, denoise,
      h("div", { class: "grid-2" }, field("Шаги", steps), field("CFG", cfg)),
      h("div", { class: "grid-2" }, field("Сэмплер", sampler), field("Планировщик", scheduler)),
      field("Seed", seed),
      quality && h("label", { class: "check" }, quality, "Теги качества",
        h("span", { class: "small muted" }, ` (${m.prefix.replace(/,\s*$/, "")})`)),
      loraRows.length > 0 && field("LoRA", h("div", { class: "loras" }, loraRows.map((r) =>
        h("div", { class: "lora" }, h("label", { class: "check" }, r.on, r.l.title), h("div", { class: "row" }, r.strength, r.value)))))),
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
            if (S.ui.prompt.value.trim() && !window.confirm("Заменить текущий промпт примером?")) return;
            S.ui.prompt.value = S.draft.prompt = sec.example;
            S.draft.original = null;
            saveDraft();
            renderPromptTools();
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

function field(label, control) {
  return h("div", { class: "field" }, h("label", { class: "label" }, label), control);
}

// --- generate -------------------------------------------------------------------------------

async function submit() {
  const m = model();
  const md = mode();
  const st = settingsFor(m);
  const p = preset();
  const settings = {
    steps: st.steps, cfg: st.cfg, sampler: st.sampler, scheduler: st.scheduler,
    quality: st.quality !== false,
    loras: (st.loras || []).filter((l) => l.on).map((l) => ({ file: l.file, strength: l.strength })),
    count: S.draft.count, seed: S.draft.seed ?? "",
  };
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
function historyGroups() {
  const groups = [];
  for (const it of [...S.task.items].reverse()) {
    const last = groups[groups.length - 1];
    if (it.type === "generated" && last && last.job === it.job) last.items.unshift(it);
    else groups.push({ job: it.type === "generated" ? it.job : null, items: [it] });
  }
  return groups;
}

function renderHistory() {
  const groups = historyGroups();
  fill(S.ui.history, groups.length
    ? groups.map((g) => (g.job ? jobEntry(g.items) : uploadEntry(g.items[0])))
    : h("p", { class: "muted empty" }, "Здесь появятся картинки."));
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
        !S.draft.images.includes(it.file) && h("button", { class: "link", onclick: () => attach(it.file) }, "В работу"))));
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
        h("p", {}, h("b", {}, it.model_title), it.preset_title ? ` · ${it.preset_title}` : "",
          ` · seed ${it.seed}`, it.size ? ` · ${it.size[0]}×${it.size[1]}` : "",
          it.seconds ? ` · ${seconds(it.seconds)}` : ""),
        it.prompt && h("p", { class: "small" }, it.prompt),
        it.negative && h("p", { class: "small muted" }, "Негатив: " + it.negative),
      ]
      : [analysisView(it, false)];
    fill(dlg, 
      h("div", { class: "viewer-top" },
        h("span", { class: "small" }, `${index + 1} / ${list.length}`),
        h("span", { class: "spacer" }),
        h("button", { class: "icon-btn", onclick: () => dlg.close() }, "✕")),
      h("div", { class: "viewer-img" },
        list.length > 1 && h("button", { class: "nav prev", onclick: () => step(-1) }, "‹"),
        h("img", { src: fileUrl(f), alt: "" }),
        list.length > 1 && h("button", { class: "nav next", onclick: () => step(1) }, "›")),
      h("div", { class: "viewer-info" }, info),
      h("div", { class: "row viewer-actions" },
        h("a", { class: "btn", href: fileUrl(f) + "?download=1", download: "" }, "Скачать"),
        h("button", { class: "btn", onclick: () => { dlg.close(); attach(f); } }, "В работу"),
        it.type === "generated" && h("button", { class: "btn", onclick: () => { dlg.close(); repeat(it); } }, "Повторить настройки")));
  }

  let touchX = null;
  dlg.ontouchstart = (e) => { touchX = e.touches[0].clientX; };
  dlg.ontouchend = (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60 && list.length > 1) step(dx < 0 ? 1 : -1);
    touchX = null;
  };
  dlg.onkeydown = (e) => {
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  };
  show();
  dlg.showModal();
}

function repeat(it) {
  const images = (it.inputs || []).filter((f) => item(f));
  Object.assign(S.draft, {
    model: it.model, images, white_bg: !!it.white_bg,
    prompt: it.prompt || "", negative: it.negative || "", original: null, seed: "",
  });
  if (images.length) {
    S.draft.action = it.preset || null;
    S.draft.denoise = it.mode === "img2img" ? it.settings?.denoise ?? null : null;
  } else {
    if (it.preset) S.draft.kind = it.preset;
    if (it.size) S.draft.size = { w: it.size[0], h: it.size[1] };
  }
  const s = it.settings || {};
  const old = store.get("settings:" + it.model, {});
  store.set("settings:" + it.model, {
    ...old,
    ...(s.steps ? { steps: s.steps } : {}), ...(s.cfg != null ? { cfg: s.cfg } : {}),
    ...(s.sampler ? { sampler: s.sampler } : {}), ...(s.scheduler ? { scheduler: s.scheduler } : {}),
    quality: s.quality !== false,
    loras: (s.loras || []).map((l) => ({ ...l, on: true })),
  });
  saveDraft();
  S.ui.prompt.value = S.draft.prompt;
  S.ui.negative.value = S.draft.negative;
  refreshComposer();
  S.ui.attach.scrollIntoView({ behavior: "smooth", block: "start" });
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
