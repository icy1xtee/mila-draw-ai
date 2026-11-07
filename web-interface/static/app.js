// Мастерская артов — страница веб-интерфейса. Без сборки: обычный ES-модуль.
// Устройство и сценарий — web-interface/README.md.

import { renderMarkdown } from "./md.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const fileUrl = (p, download) => `/files/${enc(p)}${download ? "?download=1" : ""}`;
const thumbUrl = (p, size = 480) => `/thumbs/${enc(p)}?size=${size}`;

const PURPOSE = { backgrounds: "фоны", sprites: "персонажи", drafts: "черновики" };
const KIND_ICON = { character: "🧍", background: "🏙️", other: "🎨" };
const SAMPLERS = ["euler", "euler_ancestral", "er_sde", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "dpmpp_3m_sde", "uni_pc", "ddim", "res_multistep"];
const SCHEDULERS = ["simple", "normal", "karras", "exponential", "sgm_uniform", "beta"];

const state = {
  me: null,
  users: [],
  needPassword: false,
  catalog: null,
  tasks: [],
  kinds: {},
  task: null,
  tab: "generate",
  forms: {},
  helper: { open: false, idea: "", busy: false, comment: "" },
  status: null,
  pollTimer: null,
  seenFinished: null,
  jobDone: {},
  lastTaskRefresh: 0,
  selecting: false,
  picked: new Set(),
  viewer: null,
  lastTaskId: null,
};

// --- helpers ----------------------------------------------------------------------------------

async function api(path, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.json !== undefined) {
    o.method = o.method || "POST";
    o.body = JSON.stringify(o.json);
    o.headers["Content-Type"] = "application/json";
    delete o.json;
  }
  const r = await fetch(path, o);
  if (r.status === 401 && !path.startsWith("/api/login")) {
    state.me = null;
    showLogin();
    throw new Error("Нужно войти");
  }
  const type = r.headers.get("content-type") || "";
  const data = type.includes("json") ? await r.json() : await r.blob();
  if (!r.ok) throw new Error((data && data.detail) || `Ошибка ${r.status}`);
  return data;
}

let toastTimer;
function toast(message, error = false) {
  $(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast" + (error ? " error" : "");
  el.textContent = message;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), error ? 6000 : 3000);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m} мин ${s} с` : `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `сегодня ${time}`;
  return `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${time}`;
}

const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: forms just won't be remembered */
    }
  },
};

async function downloadZip(paths, name) {
  const blob = await api("/api/zip", { json: { paths, name } });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `${name}.zip` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function pickFiles({ accept = "", capture = false } = {}) {
  return new Promise((resolve) => {
    const input = $("#file-picker");
    input.value = "";
    input.accept = accept;
    if (capture) input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

// --- start, login, routing --------------------------------------------------------------------

async function init() {
  const s = await api("/api/session");
  state.users = s.users;
  state.needPassword = s.password;
  if (s.who) {
    state.me = s.who;
    await afterLogin();
  } else showLogin();
}

function showLogin() {
  $("#top").classList.add("hidden");
  let who = store.get("who") || "";
  const view = $("#view");
  const draw = () => {
    view.innerHTML = `
      <div class="login panel stack">
        <h1>Мастерская артов</h1>
        <p class="muted">Генерация артов для «On the Other Side». Кто вы?</p>
        <div class="names">${state.users
          .map((u) => `<button type="button" data-name="${esc(u)}" class="${u === who ? "on" : ""}">${esc(u)}</button>`)
          .join("")}</div>
        <label class="field"><span>Или своё имя</span><input type="text" id="login-name" value="${esc(
          state.users.includes(who) ? "" : who,
        )}" placeholder="Имя"></label>
        ${state.needPassword ? `<label class="field"><span>Пароль</span><input type="password" id="login-pass" autocomplete="current-password"></label>` : ""}
        <button class="primary big" id="login-go">Войти</button>
      </div>`;
  };
  draw();
  view.onclick = (e) => {
    const b = e.target.closest("[data-name]");
    if (b) {
      who = b.dataset.name;
      draw();
    }
    if (e.target.id === "login-go") doLogin();
  };
  view.onkeydown = (e) => {
    if (e.key === "Enter") doLogin();
  };
  async function doLogin() {
    const name = ($("#login-name")?.value || "").trim() || who;
    try {
      await api("/api/login", { json: { who: name, password: $("#login-pass")?.value || "" } });
      store.set("who", name);
      state.me = name;
      view.onclick = view.onkeydown = null;
      await afterLogin();
    } catch (err) {
      toast(err.message, true);
    }
  }
}

async function afterLogin() {
  $("#top").classList.remove("hidden");
  $("#who").textContent = state.me;
  try {
    state.catalog = await api("/api/catalog");
  } catch (e) {
    toast(e.message, true);
  }
  pollStatus();
  route();
}

$("#who").onclick = async () => {
  if (!confirm(`Выйти (${state.me})?`)) return;
  await api("/api/logout", { method: "POST" });
  state.me = null;
  showLogin();
};

function route() {
  if (!state.me) return showLogin();
  const [, view, ...rest] = location.hash.split("/");
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === (view === "task" ? "tasks" : view || "tasks")));
  $("#view").onclick = $("#view").oninput = $("#view").onchange = null;
  state.selecting = false;
  state.picked.clear();
  if (view === "task" && rest[0]) return showTask(decodeURIComponent(rest[0]), rest[1] || "generate");
  if (view === "library") return showLibrary(rest.map(decodeURIComponent).join("/"));
  return showTasks();
}

window.addEventListener("hashchange", route);

// --- queue bar --------------------------------------------------------------------------------

async function pollStatus() {
  clearTimeout(state.pollTimer);
  if (!state.me) return;
  try {
    const s = await api("/api/status");
    state.status = s;
    renderQueue();
    afterStatus(s);
  } catch {
    /* server restarting — try again */
  }
  const active = state.status?.active?.length;
  state.pollTimer = setTimeout(pollStatus, active ? 1500 : 5000);
}

function afterStatus(s) {
  let refresh = false;
  const all = [...s.active, ...s.finished];
  if (!state.seenFinished) state.seenFinished = new Set(s.finished.map((j) => j.id));
  for (const job of all) {
    const prev = state.jobDone[job.id] ?? 0;
    if (job.done > prev && state.task && job.task_id === state.task.id) refresh = true;
    state.jobDone[job.id] = job.done;
  }
  for (const job of s.finished) {
    if (state.seenFinished.has(job.id)) continue;
    state.seenFinished.add(job.id);
    if (state.task && job.task_id === state.task.id) refresh = true;
    if (job.status === "error") toast(`Не получилось: ${job.error}`, true);
    else if (job.status === "done" && job.who === state.me) toast(`Готово: ${job.task_title} — ${job.done} шт.`);
  }
  const journal = state.task?.journal?.state;
  if (state.task && (journal === "pending" || journal === "running") && Date.now() - state.lastTaskRefresh > 5000) refresh = true;
  if (refresh) refreshTask();
  renderTaskJobs();
}

function renderQueue() {
  const s = state.status;
  const box = $("#queue");
  if (!s || !s.active.length) {
    box.classList.add("hidden");
    box.classList.remove("open");
    return;
  }
  box.classList.remove("hidden");
  const job = s.active[0];
  const more = s.active.length - 1;
  $("#queue-title").textContent = `${job.task_title} · ${job.model_title} · ${job.stage}${job.count > 1 ? ` (${job.done}/${job.count})` : ""}`;
  $("#queue-time").textContent = `≈ ${fmtTime(s.total_remaining)}${more ? ` · ещё ${more} в очереди` : ""}`;
  $("#queue-bar").style.width = `${Math.round(job.progress * 100)}%`;
  $("#queue-list").innerHTML = s.active
    .map(
      (j, i) => `
      <div class="queue-item">
        <div class="grow"><b>${i === 0 ? "Сейчас" : `${i + 1}.`} ${esc(j.task_title)}</b> — ${esc(j.model_title)}, ${j.count} шт. · ${esc(j.who)}<br>
          <span class="muted">${esc(j.stage)} · готово ≈ через ${fmtTime(j.eta)}</span></div>
        <button class="chip-btn danger" data-cancel="${j.id}">Отменить</button>
      </div>`,
    )
    .join("");
}

$("#queue").onclick = async (e) => {
  const cancel = e.target.closest("[data-cancel]");
  if (cancel) {
    e.stopPropagation();
    if (!confirm("Отменить эту генерацию?")) return;
    try {
      await api(`/api/jobs/${cancel.dataset.cancel}`, { method: "DELETE" });
      toast("Отменено");
      pollStatus();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  $("#queue").classList.toggle("open");
};

// --- tasks list -------------------------------------------------------------------------------

async function showTasks() {
  state.task = null;
  const view = $("#view");
  view.innerHTML = `<div class="empty"><span class="spin"></span></div>`;
  let data;
  try {
    data = await api("/api/tasks");
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  state.tasks = data.tasks;
  state.kinds = data.kinds;
  let kind = "character";
  view.innerHTML = `
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">Задачи</h1><span class="spacer"></span>
      <button class="primary" id="new-task">+ Новая задача</button></div>
    <div class="panel stack hidden" id="new-form" style="margin-bottom:16px">
      <h2>Новая задача</h2>
      <label class="field"><span>Что делаем</span><input type="text" id="task-title" placeholder="Например: персонаж Марк — концепт"></label>
      <div><span class="label">Тип</span><div class="segmented" id="task-kind">${Object.entries(data.kinds)
        .map(([k, v]) => `<button type="button" data-kind="${k}" class="${k === kind ? "on" : ""}">${KIND_ICON[k] || ""} ${esc(v)}</button>`)
        .join("")}</div></div>
      <div class="row"><button class="primary" id="task-create">Создать</button><button class="ghost" id="task-cancel">Отмена</button></div>
    </div>
    ${
      data.tasks.length
        ? `<div class="cards">${data.tasks.map(taskCard).join("")}</div>`
        : `<div class="empty panel"><p><b>Пока ни одной задачи.</b></p><p>Задача — одна работа: «персонаж X», «фон кафе». В ней лежат референсы, наброски, все картинки и дневник.</p></div>`
    }`;
  view.onclick = async (e) => {
    if (e.target.id === "new-task") {
      $("#new-form").classList.remove("hidden");
      $("#task-title").focus();
    }
    if (e.target.id === "task-cancel") $("#new-form").classList.add("hidden");
    const k = e.target.closest("[data-kind]");
    if (k) {
      kind = k.dataset.kind;
      $$("#task-kind button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
    }
    if (e.target.id === "task-create") {
      try {
        const task = await api("/api/tasks", { json: { title: $("#task-title").value, kind } });
        location.hash = `#/task/${encodeURIComponent(task.id)}/inputs`;
      } catch (err) {
        toast(err.message, true);
      }
    }
  };
}

function taskCard(t) {
  return `
    <a class="card" href="#/task/${encodeURIComponent(t.id)}">
      <div class="cover" ${t.cover ? `style="background-image:url('${thumbUrl(t.cover, 480)}')"` : ""}>${t.cover ? "" : KIND_ICON[t.kind] || "🎨"}</div>
      <div class="body">
        <b>${esc(t.title)}</b>
        <div class="row small muted" style="margin-top:4px">
          <span class="status ${t.status === "final" ? "final" : "active"}">${t.status === "final" ? "финал" : "в работе"}</span>
          <span>${esc(t.kind_title)}</span><span>· ${t.outputs} карт.</span><span>· ${fmtDate(t.updated)}</span>
        </div>
      </div>
    </a>`;
}

// --- task -------------------------------------------------------------------------------------

async function showTask(id, tab) {
  state.tab = tab;
  state.lastTaskId = id;
  const view = $("#view");
  if (!state.task || state.task.id !== id) {
    view.innerHTML = `<div class="empty"><span class="spin"></span></div>`;
    try {
      state.task = await api(`/api/tasks/${encodeURIComponent(id)}`);
      state.lastTaskRefresh = Date.now();
    } catch (e) {
      view.innerHTML = `<div class="empty">${esc(e.message)}<p><a href="#/tasks">К задачам</a></p></div>`;
      return;
    }
  }
  const t = state.task;
  const base = `#/task/${encodeURIComponent(t.id)}`;
  const tabs = [
    ["generate", "Генерация", ""],
    ["images", "Картинки", t.outputs],
    ["inputs", "Входящее", t.inputs + t.user_notes.length],
    ["journal", "Дневник", ""],
  ];
  view.innerHTML = `
    <div id="task-head"></div>
    <nav class="tabs">${tabs
      .map(([k, title, n]) => `<a href="${base}/${k}" class="${k === tab ? "active" : ""}">${title} ${n !== "" ? `<span class="count">${n}</span>` : ""}</a>`)
      .join("")}</nav>
    <div id="tab"></div>`;
  renderTaskHead();
  if (tab === "generate") renderGenerateTab();
  else if (tab === "images") renderImagesTab();
  else if (tab === "inputs") renderInputsTab();
  else renderJournalTab();
}

async function refreshTask() {
  if (!state.task) return;
  try {
    state.task = await api(`/api/tasks/${encodeURIComponent(state.task.id)}`);
    state.lastTaskRefresh = Date.now();
  } catch {
    return;
  }
  renderTaskHead();
  $$(".tabs .count").forEach((el, i) => {
    const t = state.task;
    el.textContent = [t.outputs, t.inputs + t.user_notes.length][i] ?? el.textContent;
  });
  if ($("#recent")) renderRecent();
  if ($("#gallery")) renderGallery();
  if ($("#inputs-list")) renderInputsList();
  if ($("#journal")) renderJournal();
  if (state.viewer) refreshViewer();
}

function renderTaskHead() {
  const t = state.task;
  const box = $("#task-head");
  if (!box) return;
  box.innerHTML = `
    <div class="small"><a href="#/tasks">← Задачи</a></div>
    <div class="row" style="margin-top:6px"><h1 style="margin:0">${KIND_ICON[t.kind] || ""} ${esc(t.title)}</h1>
      <span class="status ${t.status === "final" ? "final" : "active"}">${t.status === "final" ? "финал" : "в работе"}</span></div>
    <div class="small muted" style="margin-top:4px">${esc(t.kind_title)} · завёл(а) ${esc(t.who)} ${fmtDate(t.created)}</div>`;
}

// --- generation form --------------------------------------------------------------------------

function modelOf(key) {
  return state.catalog.models.find((m) => m.key === key) || state.catalog.models[0];
}

function defaultForm(task) {
  const want = { character: "sprites", background: "backgrounds" }[task.kind];
  const model = state.catalog.models.find((m) => m.good_for.includes(want)) || state.catalog.models[0];
  const size = { character: "sprite", background: "background" }[task.kind] || "square";
  const form = { model: model.key, prompt: "", negative: "", blocks: [], loras: [], size, count: 2, seed: "", init: null, denoise: 0.6, steps: "", cfg: "", sampler: "", scheduler: "" };
  form.blocks = state.catalog.blocks.filter((b) => b.default || (b.default_for || []).includes(size)).map((b) => b.id);
  return form;
}

function getForm() {
  const id = state.task.id;
  if (!state.forms[id]) state.forms[id] = { ...defaultForm(state.task), ...(store.get(`form:${id}`) || {}) };
  return state.forms[id];
}

let saveTimer;
function saveForm() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(`form:${state.task.id}`, getForm()), 400);
}

function blockApplies(block, family) {
  return block.families.includes("*") || block.families.includes(family);
}

function renderGenerateTab() {
  $("#tab").innerHTML = `
    <div class="split">
      <div class="sticky"><form class="panel stack" id="gen-form" autocomplete="off"></form></div>
      <div>
        <div id="task-jobs"></div>
        <div class="row" style="margin:4px 0 8px"><h2 style="margin:0">Последние</h2><span class="spacer"></span>
          <a href="#/task/${encodeURIComponent(state.task.id)}/images" class="small">все картинки →</a></div>
        <div id="recent"></div>
      </div>
    </div>`;
  renderForm();
  renderTaskJobs();
  renderRecent();
  $("#gen-form").onsubmit = (e) => e.preventDefault();
  const view = $("#view");
  view.onclick = onFormClick;
  view.oninput = onFormInput;
  view.onchange = onFormChange;
}

function renderForm() {
  const box = $("#gen-form");
  if (!box) return;
  const f = getForm();
  const c = state.catalog;
  const model = modelOf(f.model);
  const family = model.family;
  const loras = c.loras.filter((l) => !l.family || l.family === family);
  const groups = Object.entries(c.groups);
  const sizeKeys = Object.keys(c.sizes);
  const p = model.params;
  box.innerHTML = `
    <div>
      <span class="label">Модель</span>
      <div class="models">${c.models
        .map(
          (m) => `<button type="button" class="model ${m.key === f.model ? "on" : ""}" data-model="${m.key}">
            <b>${esc(m.title)}</b><div class="hint">${esc(m.hint)}</div>
            <div class="tags">${m.good_for.map((g) => `<span class="tag">${PURPOSE[g] || g}</span>`).join("")}</div></button>`,
        )
        .join("")}</div>
    </div>

    <div>
      <div class="row"><span class="label" style="margin:0">Промпт</span><span class="spacer"></span>
        <button type="button" class="chip-btn" data-act="helper">${state.helper.open ? "Скрыть помощника" : "✨ Помочь с промптом"}</button></div>
      ${
        state.helper.open
          ? `<div class="helper stack">
              <label class="field"><span>Опишите идею по-русски</span>
              <textarea data-helper="idea" placeholder="Например: Марта у стойки кафе утром, улыбается, держит чашку">${esc(state.helper.idea)}</textarea></label>
              <div class="row"><button type="button" class="primary" data-act="helper-go" ${state.helper.busy ? "disabled" : ""}>
                ${state.helper.busy ? `<span class="spin"></span> Claude думает…` : "Собрать промпт"}</button>
                <span class="small muted">≈ 15–40 с. Промпт можно будет поправить.</span></div>
              ${state.helper.comment ? `<div class="small">${esc(state.helper.comment)}</div>` : ""}
            </div>`
          : ""
      }
      <textarea data-bind="prompt" placeholder="${family === "illustrious" ? "Теги через запятую, по-английски" : family === "flux" ? "Обычными фразами по-английски: кадр → кто/что → фон → свет" : "Теги, затем пара предложений по-английски"}" style="margin-top:8px">${esc(f.prompt)}</textarea>
    </div>

    ${
      model.negative_works
        ? `<label class="field"><span>Негатив — чего не должно быть</span><textarea data-bind="negative" style="min-height:60px">${esc(f.negative)}</textarea></label>`
        : `<div class="hint">У ${esc(model.title)} негативный промпт не работает (CFG 1): всё, чего не должно быть, пишите в промпт словами — «no people», «no text».</div>`
    }

    <div>
      <span class="label">Предпромпты</span>
      <div class="blocks">${groups
        .map(([g, title]) => {
          const items = c.blocks.filter((b) => b.group === g);
          if (!items.length) return "";
          return `<div class="group-title">${esc(title)}</div>${items
            .map((b) => {
              const ok = blockApplies(b, family);
              return `<label class="block ${ok ? "" : "off"}" title="${ok ? "" : "Для этой модели блок ничего не добавляет"}">
                <input type="checkbox" data-block="${b.id}" ${f.blocks.includes(b.id) ? "checked" : ""} ${ok ? "" : "disabled"}>
                <span><b>${esc(b.title)}</b><div class="hint">${esc(b.hint)}</div></span></label>`;
            })
            .join("")}`;
        })
        .join("")}</div>
    </div>

    <div>
      <span class="label">LoRA</span>
      ${f.loras
        .map((l, i) => {
          const info = c.loras.find((x) => x.file === l.file) || { title: l.file, range: [0, 1.5] };
          const wrong = info.family && info.family !== family;
          return `<div class="lora">
            <div class="lora-head"><b>${esc(info.title)}</b><span class="lora-strength" data-strength-label="${i}">${Number(l.strength).toFixed(2)}</span>
              <button type="button" class="chip-btn ghost" data-lora-remove="${i}" title="Убрать">✕</button></div>
            ${info.hint ? `<div class="hint">${esc(info.hint)}</div>` : ""}
            ${wrong ? `<div class="hint" style="color:var(--warn)">Эта LoRA для другой модели (${esc(info.family)}) — при генерации не применится правильно.</div>` : ""}
            <input type="range" min="${info.range[0]}" max="${info.range[1]}" step="0.05" value="${l.strength}" data-lora-strength="${i}">
          </div>`;
        })
        .join("")}
      ${
        loras.length
          ? `<select data-act="lora-add"><option value="">+ Добавить LoRA…</option>${loras
              .filter((l) => !f.loras.some((x) => x.file === l.file))
              .map((l) => `<option value="${esc(l.file)}">${esc(l.title)}${l.described ? "" : " (без описания)"}</option>`)
              .join("")}</select>`
          : `<div class="hint">Для этой модели LoRA пока нет — они появятся, когда Павел добавит их в каталог.</div>`
      }
    </div>

    <div>
      <span class="label">Размер</span>
      <div class="segmented">${sizeKeys
        .map((k) => `<button type="button" data-size="${k}" class="${k === f.size ? "on" : ""}">${esc(c.sizes[k].title)}</button>`)
        .join("")}</div>
    </div>

    <div>
      <span class="label">Сколько вариантов</span>
      <div class="segmented">${[1, 2, 3, 4].map((n) => `<button type="button" data-count="${n}" class="${n === Number(f.count) ? "on" : ""}">${n}</button>`).join("")}</div>
    </div>

    ${
      f.init
        ? `<div><span class="label">За основу</span>
            <div class="init-preview"><img src="${thumbUrl(f.init, 200)}" alt="">
              <div style="flex:1"><div class="small">Насколько менять: <b data-denoise-label>${Number(f.denoise).toFixed(2)}</b></div>
                <input type="range" min="0.1" max="1" step="0.05" value="${f.denoise}" data-bind="denoise">
                <div class="hint">0.3 — чуть поправить, 0.6 — заметно переделать, 0.9 — почти с нуля.</div></div>
              <button type="button" class="chip-btn ghost" data-act="init-clear" title="Убрать">✕</button></div></div>`
        : ""
    }

    <details ${f.steps || f.cfg || f.sampler || f.seed ? "open" : ""}>
      <summary>Дополнительно</summary>
      <div class="stack">
        <label class="field"><span>Seed</span><input type="number" data-bind="seed" value="${esc(f.seed)}" placeholder="случайный">
          <div class="hint">Один seed + тот же промпт = та же картинка. Варианты получают seed, seed+1, …</div></label>
        <div class="row" style="align-items:flex-start">
          <label class="field" style="flex:1"><span>Шаги</span><input type="number" data-bind="steps" value="${esc(f.steps)}" placeholder="${p.steps}"></label>
          <label class="field" style="flex:1"><span>CFG</span><input type="number" step="0.5" data-bind="cfg" value="${esc(f.cfg)}" placeholder="${p.cfg}"></label>
        </div>
        <div class="row" style="align-items:flex-start">
          <label class="field" style="flex:1"><span>Сэмплер</span><select data-bind="sampler"><option value="">${p.sampler} (по умолч.)</option>${SAMPLERS.map(
            (s) => `<option ${s === f.sampler ? "selected" : ""}>${s}</option>`,
          ).join("")}</select></label>
          <label class="field" style="flex:1"><span>Планировщик</span><select data-bind="scheduler"><option value="">${p.scheduler} (по умолч.)</option>${SCHEDULERS.map(
            (s) => `<option ${s === f.scheduler ? "selected" : ""}>${s}</option>`,
          ).join("")}</select></label>
        </div>
        <button type="button" class="chip-btn" data-act="reset-advanced">Сбросить к настройкам модели</button>
      </div>
    </details>

    <button type="submit" class="primary big" data-act="submit">Нарисовать ${Number(f.count) > 1 ? `${f.count} варианта` : ""}</button>`;
}

function onFormInput(e) {
  const f = state.task && getForm();
  if (!f) return;
  const bind = e.target.dataset.bind;
  if (bind) {
    f[bind] = e.target.value;
    if (bind === "denoise") $("[data-denoise-label]").textContent = Number(e.target.value).toFixed(2);
    saveForm();
  }
  if (e.target.dataset.helper) state.helper.idea = e.target.value;
  const li = e.target.dataset.loraStrength;
  if (li !== undefined) {
    f.loras[li].strength = Number(e.target.value);
    $(`[data-strength-label="${li}"]`).textContent = Number(e.target.value).toFixed(2);
    saveForm();
  }
}

function onFormChange(e) {
  const f = state.task && getForm();
  if (!f) return;
  if (e.target.dataset.block) {
    const id = e.target.dataset.block;
    f.blocks = e.target.checked ? [...new Set([...f.blocks, id])] : f.blocks.filter((b) => b !== id);
    saveForm();
  }
  if (e.target.dataset.act === "lora-add" && e.target.value) {
    const info = state.catalog.loras.find((l) => l.file === e.target.value);
    f.loras.push({ file: info.file, strength: info.strength ?? 0.8 });
    saveForm();
    renderForm();
  }
}

async function onFormClick(e) {
  if (e.target.closest("[data-open]")) return openFromGallery(e);
  const f = state.task && getForm();
  if (!f || !e.target.closest("#gen-form")) return;
  const el = e.target.closest("[data-model],[data-size],[data-count],[data-act],[data-lora-remove]");
  if (!el) return;
  if (el.dataset.act === "submit") {
    e.preventDefault();
    return submitForm();
  }
  if (el.dataset.model) {
    f.model = el.dataset.model;
    f.steps = f.cfg = f.sampler = f.scheduler = "";
  } else if (el.dataset.size) {
    const old = f.size;
    f.size = el.dataset.size;
    for (const b of state.catalog.blocks) {
      const d = b.default_for || [];
      if (d.includes(f.size)) f.blocks = [...new Set([...f.blocks, b.id])];
      else if (d.includes(old)) f.blocks = f.blocks.filter((x) => x !== b.id);
    }
  } else if (el.dataset.count) f.count = Number(el.dataset.count);
  else if (el.dataset.loraRemove !== undefined) f.loras.splice(Number(el.dataset.loraRemove), 1);
  else if (el.dataset.act === "init-clear") f.init = null;
  else if (el.dataset.act === "reset-advanced") f.steps = f.cfg = f.sampler = f.scheduler = f.seed = "";
  else if (el.dataset.act === "helper") state.helper.open = !state.helper.open;
  else if (el.dataset.act === "helper-go") return promptHelp();
  else return;
  saveForm();
  renderForm();
}

async function promptHelp() {
  const f = getForm();
  if (!state.helper.idea.trim()) return toast("Опишите идею — хоть парой слов", true);
  state.helper.busy = true;
  state.helper.comment = "";
  renderForm();
  try {
    const r = await api("/api/prompt-help", { json: { idea: state.helper.idea, model: f.model, blocks: f.blocks, task_id: state.task.id } });
    f.prompt = r.prompt;
    if (r.negative && modelOf(f.model).negative_works) f.negative = r.negative;
    state.helper.comment = r.comment;
    saveForm();
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.helper.busy = false;
    renderForm();
  }
}

async function submitForm(overrides = null) {
  const f = overrides || getForm();
  if (!String(f.prompt || "").trim()) return toast("Напишите промпт — или нажмите «Помочь с промптом»", true);
  const size = state.catalog.sizes[f.size] || { width: f.width, height: f.height };
  const payload = {
    task_id: state.task.id,
    model: f.model,
    prompt: f.prompt,
    negative: f.negative || "",
    blocks: f.blocks,
    loras: f.loras,
    size: f.size,
    width: size.width,
    height: size.height,
    count: Number(f.count) || 1,
    seed: f.seed === "" || f.seed == null ? null : Number(f.seed),
  };
  if (f.init) Object.assign(payload, { init: f.init, denoise: Number(f.denoise) });
  for (const k of ["steps", "cfg", "sampler", "scheduler"]) if (f[k] !== "" && f[k] != null) payload[k] = f[k];
  try {
    const job = await api("/api/jobs", { json: payload });
    toast(job.position ? `В очереди: перед вами ${job.position}` : "Рисую…");
    await pollStatus();
    // On a phone the progress cards sit below the long form: bring them into view.
    if (window.innerWidth < 1000) $("#task-jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    toast(err.message, true);
  }
}

// --- task jobs and galleries ------------------------------------------------------------------

function renderTaskJobs() {
  const box = $("#task-jobs");
  if (!box || !state.task) return;
  const jobs = (state.status?.active || []).filter((j) => j.task_id === state.task.id);
  if (!jobs.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="gallery wide" style="margin-bottom:12px">${jobs
    .map((j) =>
      Array.from({ length: j.count - j.done }, (_, i) => {
        const current = j.status === "running" && i === 0;
        return `<div class="pending-card">
          <b>${esc(j.model_title)}</b>
          <span class="muted">${current ? esc(j.stage) : j.status === "queued" ? `в очереди${j.position ? `, перед вами ${j.position}` : ""}` : "ждёт своей очереди"}</span>
          ${current ? `<div class="bar"><i style="width:${j.steps ? Math.round((j.step / j.steps) * 100) : 5}%"></i></div>` : ""}
          <span class="small">готово ≈ через ${fmtTime(j.eta)}</span>
        </div>`;
      }).join(""),
    )
    .join("")}</div>`;
}

function thumbHtml(item, i, list) {
  const t = state.task;
  const star = t?.stars?.includes(item.path);
  const fin = t?.finals?.includes(item.path);
  const nobg = item.name.includes("_nobg");
  return `<button class="thumb ${state.picked.has(item.path) ? "picked" : ""} ${nobg ? "checker" : ""}" data-open="${i}" data-list="${list}" data-path="${esc(item.path)}">
    <img src="${thumbUrl(item.path)}" alt="" loading="lazy">
    <span class="badges">${star ? `<span class="badge star">★</span>` : ""}${fin ? `<span class="badge final">финал</span>` : ""}${nobg ? `<span class="badge">без фона</span>` : ""}</span>
    <span class="pick"></span></button>`;
}

function renderRecent() {
  const box = $("#recent");
  if (!box) return;
  const items = [...state.task.outputs_list].reverse().slice(0, 12);
  state.lists = { ...(state.lists || {}), recent: items };
  box.innerHTML = items.length
    ? `<div class="gallery wide">${items.map((it, i) => thumbHtml(it, i, "recent")).join("")}</div>`
    : `<div class="empty panel">Здесь появятся картинки. Заполните форму и нажмите «Нарисовать».</div>`;
}

function renderImagesTab() {
  $("#tab").innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <button class="chip-btn" data-act="select">${state.selecting ? "Готово" : "Выбрать несколько"}</button>
      <span class="small muted" id="picked-count"></span><span class="spacer"></span>
      <button class="chip-btn" data-act="zip-picked">Скачать выбранные</button>
      <button class="chip-btn" data-act="zip-stars">Скачать ★</button>
    </div>
    <div id="gallery"></div>`;
  renderGallery();
  $("#view").onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "select") {
      state.selecting = !state.selecting;
      state.picked.clear();
      renderImagesTab();
      return;
    }
    if (act === "zip-picked") {
      if (!state.picked.size) return toast("Сначала выберите картинки", true);
      return downloadZip([...state.picked], state.task.id);
    }
    if (act === "zip-stars") {
      if (!state.task.stars.length) return toast("Пока нет картинок со ★", true);
      return downloadZip(state.task.stars, `${state.task.id}-stars`);
    }
    const th = e.target.closest("[data-open]");
    if (th && state.selecting) {
      const p = th.dataset.path;
      state.picked.has(p) ? state.picked.delete(p) : state.picked.add(p);
      th.classList.toggle("picked");
      $("#picked-count").textContent = state.picked.size ? `выбрано: ${state.picked.size}` : "";
      return;
    }
    if (th) openFromGallery(e);
  };
}

function renderGallery() {
  const box = $("#gallery");
  if (!box) return;
  const items = [...state.task.outputs_list].reverse();
  state.lists = { ...(state.lists || {}), gallery: items };
  box.className = state.selecting ? "selecting" : "";
  box.innerHTML = items.length
    ? `<div class="gallery wide">${items.map((it, i) => thumbHtml(it, i, "gallery")).join("")}</div>`
    : `<div class="empty panel">Картинок пока нет.</div>`;
}

function openFromGallery(e) {
  const th = e.target.closest("[data-open]");
  const list = state.lists?.[th.dataset.list] || [];
  openViewer(list, Number(th.dataset.open), th.dataset.list === "inputs" ? "input" : th.dataset.list === "library" ? "library" : "output");
}

// --- inputs -----------------------------------------------------------------------------------

function renderInputsTab() {
  $("#tab").innerHTML = `
    <div class="split">
      <div class="stack">
        <div class="panel stack">
          <h2>Принести в задачу</h2>
          <div class="drop" id="drop">Перетащите файлы сюда<br><span class="small">или</span>
            <div class="row" style="justify-content:center;margin-top:8px">
              <button class="primary" data-act="upload">Выбрать файлы</button>
              <button data-act="camera">📷 Сфотографировать</button>
            </div></div>
          <label class="field"><span>Подпись к файлам (необязательно)</span><input type="text" id="upload-note" placeholder="Например: референс причёски"></label>
          <div class="hint">Референсы, наброски, концепты. Добавить из общей библиотеки — в разделе «Библиотека».</div>
        </div>
        <div class="panel stack">
          <h2>Заметка или идея</h2>
          <textarea id="note-text" placeholder="Что задумано, что важно, что не нравится — Claude перенесёт в дневник"></textarea>
          <button class="primary" data-act="note">Сохранить заметку</button>
          <div id="notes-list"></div>
        </div>
      </div>
      <div><div id="inputs-list"></div></div>
    </div>`;
  renderInputsList();
  const drop = $("#drop");
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    uploadFiles([...e.dataTransfer.files]);
  };
  $("#view").onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "upload") uploadFiles(await pickFiles({ accept: "image/*,.pdf,.txt,.md,.psd,.kra" }));
    if (act === "camera") uploadFiles(await pickFiles({ accept: "image/*", capture: true }));
    if (act === "note") {
      const text = $("#note-text").value.trim();
      if (!text) return toast("Пустая заметка", true);
      try {
        await api(`/api/tasks/${encodeURIComponent(state.task.id)}/notes`, { json: { text } });
        $("#note-text").value = "";
        toast("Заметка сохранена");
        refreshTask();
      } catch (err) {
        toast(err.message, true);
      }
    }
    if (e.target.closest("[data-open]")) openFromGallery(e);
  };
}

async function uploadFiles(files) {
  if (!files.length) return;
  const body = new FormData();
  files.forEach((f) => body.append("files", f, f.name));
  body.append("note", $("#upload-note")?.value || "");
  toast(`Загружаю ${files.length} файл(ов)…`);
  try {
    await api(`/api/tasks/${encodeURIComponent(state.task.id)}/uploads`, { method: "POST", body });
    toast("Загружено");
    if ($("#upload-note")) $("#upload-note").value = "";
    refreshTask();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderInputsList() {
  const t = state.task;
  const images = t.inputs_list.filter((f) => f.image);
  const other = t.inputs_list.filter((f) => !f.image);
  state.lists = { ...(state.lists || {}), inputs: images };
  const box = $("#inputs-list");
  if (box)
    box.innerHTML = `
      <h2>Входящее</h2>
      ${images.length ? `<div class="gallery">${images.map((it, i) => thumbHtml(it, i, "inputs")).join("")}</div>` : `<div class="empty panel">Пока ничего не принесли.</div>`}
      ${other
        .map(
          (f) => `<div class="file-row" style="margin-top:8px"><span>📄</span><span class="grow">${esc(f.meta.original_name || f.name)}${
            f.meta.note ? `<div class="small muted">${esc(f.meta.note)}</div>` : ""
          }</span><a class="btn chip-btn" href="${fileUrl(f.path, true)}">Скачать</a></div>`,
        )
        .join("")}`;
  const notes = $("#notes-list");
  if (notes)
    notes.innerHTML = [...t.user_notes]
      .reverse()
      .map((n) => `<div class="note"><div class="small muted">${esc(n.who)} · ${fmtDate(n.time)}</div>${esc(n.text)}</div>`)
      .join("");
}

// --- journal ----------------------------------------------------------------------------------

function renderJournalTab() {
  $("#tab").innerHTML = `<div id="journal"></div>`;
  renderJournal();
  $("#view").onclick = async (e) => {
    if (e.target.closest("[data-act='journal']")) {
      try {
        state.task.journal = await api(`/api/tasks/${encodeURIComponent(state.task.id)}/journal`, { method: "POST" });
        renderJournal();
        toast("Claude подведёт итог, когда освободится очередь");
      } catch (err) {
        toast(err.message, true);
      }
    }
  };
}

function renderJournal() {
  const box = $("#journal");
  if (!box) return;
  const t = state.task;
  const j = t.journal || { state: "off" };
  const statusLine = {
    off: "Claude на этой машине недоступен — дневник не ведётся.",
    idle: "Дневник обновляется сам после каждой порции работы.",
    pending: j.message,
    running: "Claude пишет дневник…",
    ok: `Обновлён ${fmtDate(j.time)}${j.seconds ? ` за ${Math.round(j.seconds)} с` : ""}.`,
    error: `Не получилось обновить: ${j.message}`,
  }[j.state];
  box.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <span class="small ${j.state === "error" ? "danger" : "muted"}">${j.state === "running" ? `<span class="spin"></span> ` : ""}${esc(statusLine || "")}</span>
      <span class="spacer"></span>
      <button class="chip-btn" data-act="journal" ${j.state === "off" || j.state === "running" ? "disabled" : ""}>Подвести итог сейчас</button>
    </div>
    <div class="panel md">${
      t.notes
        ? renderMarkdown(t.notes, `prototype/${t.id}/`)
        : `<p class="muted">Дневника пока нет. Он появится после первых загрузок, заметок или генераций: Claude запишет задумку, что пробовали и что понравилось.</p>`
    }</div>`;
}

// --- library ----------------------------------------------------------------------------------

async function showLibrary(path) {
  state.task = null;
  const view = $("#view");
  view.innerHTML = `<div class="empty"><span class="spin"></span></div>`;
  let data;
  try {
    data = await api(`/api/library?path=${encodeURIComponent(path)}`);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}<p><a href="#/library">В начало библиотеки</a></p></div>`;
    return;
  }
  const parts = data.path ? data.path.split("/") : [];
  const images = data.files.filter((f) => f.image);
  const other = data.files.filter((f) => !f.image);
  state.lists = { ...(state.lists || {}), library: images };
  const titles = { references: "Референсы", prototype: "Задачи", generated: "Результаты", benchmarks: "Тесты и сравнения" };
  view.innerHTML = `
    <div class="crumbs"><a href="#/library">Библиотека</a>${parts
      .map((p, i) => ` / <a href="#/library/${parts.slice(0, i + 1).map(encodeURIComponent).join("/")}">${esc(i === 0 ? titles[p] || p : p)}</a>`)
      .join("")}</div>
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">${esc(parts.length ? titles[parts.at(-1)] || parts.at(-1) : "Библиотека")}</h1>
      <span class="spacer"></span>${data.can_upload ? `<button class="primary" data-act="lib-upload">+ Добавить файлы сюда</button>` : ""}</div>
    ${!parts.length ? `<p class="muted">Всё, что лежит в content/ на MSI: рисунки Милы и мудборд, задачи, результаты прогонов. Картинку можно скачать, приложить к задаче или взять за основу.</p>` : ""}
    ${
      data.dirs.length
        ? `<div class="folders">${data.dirs
            .map(
              (d) => `<a class="folder" href="#/library/${d.path.split("/").map(encodeURIComponent).join("/")}"><span class="icon">📁</span>
                <span><b>${esc(parts.length ? d.name : titles[d.name] || d.name)}</b><div class="small muted">${d.images ? `${d.images} карт.` : ""}</div></span></a>`,
            )
            .join("")}</div>`
        : ""
    }
    ${images.length ? `<div class="gallery">${images.map((it, i) => thumbHtml(it, i, "library")).join("")}</div>` : ""}
    ${other.map((f) => `<div class="file-row" style="margin-top:8px"><span>📄</span><span class="grow">${esc(f.name)}</span><a class="btn chip-btn" href="${fileUrl(f.path)}" target="_blank">Открыть</a></div>`).join("")}
    ${!data.dirs.length && !data.files.length ? `<div class="empty panel">Папка пуста.</div>` : ""}`;
  view.onclick = async (e) => {
    if (e.target.closest("[data-act='lib-upload']")) {
      const files = await pickFiles({ accept: "image/*" });
      if (!files.length) return;
      const body = new FormData();
      body.append("path", data.path);
      files.forEach((f) => body.append("files", f, f.name));
      try {
        await api("/api/library/upload", { method: "POST", body });
        toast("Добавлено");
        showLibrary(data.path);
      } catch (err) {
        toast(err.message, true);
      }
    }
    if (e.target.closest("[data-open]")) openFromGallery(e);
  };
}

// --- viewer -----------------------------------------------------------------------------------

function openViewer(list, index, kind) {
  state.viewer = { list, index, kind };
  drawViewer();
  const dlg = $("#viewer");
  if (!dlg.open) dlg.showModal();
}

function refreshViewer() {
  const v = state.viewer;
  if (!v || !state.task) return;
  const source = v.kind === "output" ? [...state.task.outputs_list].reverse() : v.kind === "input" ? state.task.inputs_list.filter((f) => f.image) : null;
  if (source) {
    const current = v.list[v.index]?.path;
    v.list = source;
    v.index = Math.max(0, source.findIndex((x) => x.path === current));
  }
  drawViewer();
}

function drawViewer() {
  const v = state.viewer;
  const item = v.list[v.index];
  if (!item) return closeViewer();
  const m = item.meta || {};
  const form = m.form || {};
  const t = state.task;
  const star = t?.stars?.includes(item.path);
  const fin = t?.finals?.includes(item.path);
  const model = state.catalog.models.find((x) => x.key === m.model);
  const nobg = item.name.includes("_nobg");
  const actions = [];
  actions.push(`<a class="btn" href="${fileUrl(item.path, true)}">⬇ Скачать</a>`);
  if (v.kind === "output") {
    actions.push(`<button data-v="star" class="${star ? "on-star" : ""}">${star ? "★ Нравится" : "☆ Нравится"}</button>`);
    actions.push(`<button data-v="final" class="${fin ? "on-final" : ""}">${fin ? "✓ Финал" : "Финал"}</button>`);
    if (form.model) {
      actions.push(`<button data-v="more">Ещё такие же</button>`);
      actions.push(`<button data-v="edit">Повторить с правкой</button>`);
    }
  }
  if (t) actions.push(`<button data-v="init">Взять за основу</button>`);
  if (!nobg) actions.push(`<button data-v="nobg" class="wide">✂ Убрать фон</button>`);
  if (v.kind === "library") actions.push(`<button data-v="attach" class="wide">Приложить к задаче…</button>`);
  $("#viewer").innerHTML = `
    <div class="viewer-inner">
      <div class="viewer-head">
        <button class="chip-btn ghost" data-v="prev" ${v.index > 0 ? "" : "disabled"} title="Предыдущая">←</button>
        <button class="chip-btn ghost" data-v="next" ${v.index < v.list.length - 1 ? "" : "disabled"} title="Следующая">→</button>
        <b>${esc(item.name)}</b>
        <span class="small muted">${v.index + 1} / ${v.list.length}</span>
        <button class="chip-btn" data-v="close">✕</button>
      </div>
      <div class="viewer-image ${nobg ? "checker" : ""}"><a href="${fileUrl(item.path)}" target="_blank"><img src="${thumbUrl(item.path, 1600)}" alt=""></a></div>
      <div class="viewer-side">
        <div class="actions">${actions.join("")}</div>
        ${
          m.model
            ? `<dl class="kv">
                <dt>Модель</dt><dd>${esc(model?.title || m.model)}</dd>
                <dt>Seed</dt><dd>${esc(m.seed)}</dd>
                ${m.size ? `<dt>Размер</dt><dd>${m.size.join("×")}</dd>` : ""}
                ${m.seconds ? `<dt>Время</dt><dd>${m.seconds} с</dd>` : ""}
                ${m.who ? `<dt>Кто</dt><dd>${esc(m.who)}, ${fmtDate(m.time)}</dd>` : ""}
                ${form.loras?.length ? `<dt>LoRA</dt><dd>${form.loras.map((l) => `${esc(l.file)} (${l.strength})`).join(", ")}</dd>` : ""}
                ${form.blocks?.length ? `<dt>Блоки</dt><dd>${form.blocks.map((b) => esc(state.catalog.blocks.find((x) => x.id === b)?.title || b)).join(", ")}</dd>` : ""}
                ${m.init ? `<dt>Основа</dt><dd>${esc(m.init.split("/").pop())}, менять ${form.denoise}</dd>` : ""}
              </dl>
              ${form.prompt ? `<div class="label" style="margin-top:12px">Промпт</div><div class="prompt-text">${esc(form.prompt)}</div>` : ""}
              ${m.prompt_final && m.prompt_final !== form.prompt ? `<details><summary class="small">Что ушло в модель целиком</summary><div class="prompt-text">${esc(m.prompt_final)}</div>${m.negative_final ? `<div class="small muted" style="margin-top:6px">Негатив:</div><div class="prompt-text">${esc(m.negative_final)}</div>` : ""}</details>` : ""}`
            : m.who
              ? `<dl class="kv"><dt>Принёс(ла)</dt><dd>${esc(m.who)}, ${fmtDate(m.time)}</dd>${m.note ? `<dt>Подпись</dt><dd>${esc(m.note)}</dd>` : ""}${m.from ? `<dt>Откуда</dt><dd>${esc(m.from)}</dd>` : ""}</dl>`
              : `<p class="small muted">${esc(item.path)}</p>`
        }
      </div>
    </div>`;
}

function closeViewer() {
  state.viewer = null;
  const dlg = $("#viewer");
  if (dlg.open) dlg.close();
}

$("#viewer").addEventListener("close", () => (state.viewer = null));
$("#viewer").addEventListener("click", async (e) => {
  if (e.target === $("#viewer")) return closeViewer();
  const act = e.target.closest("[data-v]")?.dataset.v;
  if (!act) return;
  const v = state.viewer;
  const item = v.list[v.index];
  const t = state.task;
  try {
    if (act === "close") closeViewer();
    else if (act === "prev" || act === "next") {
      v.index += act === "next" ? 1 : -1;
      drawViewer();
    } else if (act === "star" || act === "final") {
      const on = !(act === "star" ? t.stars : t.finals).includes(item.path);
      const r = await api(`/api/tasks/${encodeURIComponent(t.id)}/marks`, { json: { file: item.path, kind: act, on } });
      Object.assign(t, r);
      drawViewer();
      refreshTask();
    } else if (act === "more") {
      const form = item.meta.form;
      await submitForm({ ...form, seed: "", init: form.init || null });
      closeViewer();
    } else if (act === "edit") {
      const form = item.meta.form;
      state.forms[t.id] = { ...defaultForm(t), ...form, seed: item.meta.seed, count: 1, steps: form.steps || "", cfg: form.cfg || "", sampler: form.sampler || "", scheduler: form.scheduler || "" };
      saveForm();
      closeViewer();
      toast("Параметры в форме, seed тот же — поменяйте промпт и рисуйте");
      goTab("generate");
    } else if (act === "init") {
      const taskId = t?.id || state.lastTaskId;
      if (!taskId) return toast("Откройте задачу, к которой нужна основа", true);
      if (state.forms[taskId]) {
        state.forms[taskId].init = item.path;
        store.set(`form:${taskId}`, state.forms[taskId]);
      } else {
        // Form not opened yet in this session: remember in the saved draft, getForm() merges it.
        store.set(`form:${taskId}`, { ...(store.get(`form:${taskId}`) || {}), init: item.path });
      }
      closeViewer();
      toast("Картинка взята за основу — она в форме генерации");
      goTab("generate");
    } else if (act === "nobg") {
      toast("Убираю фон…");
      const r = await api("/api/images/nobg", { json: { path: item.path } });
      toast("Готово: картинка без фона рядом с исходной");
      if (state.task) {
        await refreshTask();
        const idx = v.list.findIndex((x) => x.path === r.path);
        if (idx >= 0) {
          v.index = idx;
          drawViewer();
        }
      } else showLibrary(item.path.split("/").slice(0, -1).join("/"));
    } else if (act === "attach") {
      const tasks = (await api("/api/tasks")).tasks;
      if (!tasks.length) return toast("Сначала заведите задачу", true);
      const list = tasks.map((x, i) => `${i + 1}. ${x.title}`).join("\n");
      const n = Number(prompt(`В какую задачу положить?\n${list}`, "1"));
      const target = tasks[n - 1];
      if (!target) return;
      await api(`/api/tasks/${encodeURIComponent(target.id)}/attach`, { json: { path: item.path } });
      toast(`Добавлено во «Входящее»: ${target.title}`);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener("keydown", (e) => {
  if (!state.viewer) return;
  if (e.key === "ArrowRight" && state.viewer.index < state.viewer.list.length - 1) {
    state.viewer.index++;
    drawViewer();
  }
  if (e.key === "ArrowLeft" && state.viewer.index > 0) {
    state.viewer.index--;
    drawViewer();
  }
});

function goTab(tab) {
  const id = state.task?.id || state.lastTaskId;
  const target = `#/task/${encodeURIComponent(id)}/${tab}`;
  if (location.hash === target) route();
  else location.hash = target;
}

init().catch((e) => {
  $("#view").innerHTML = `<div class="empty">Сервер не отвечает: ${esc(e.message)}</div>`;
});
