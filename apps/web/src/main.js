import { createClient } from "@supabase/supabase-js";

// Адрес базы и публичный ключ приезжают из переменных проекта Layero.
const DATA_URL = import.meta.env.VITE_LAYERO_DATA_URL;
const DATA_KEY = import.meta.env.VITE_LAYERO_DATA_KEY;
const db = createClient(DATA_URL, DATA_KEY);
const WIDGET_URL = (import.meta.env.VITE_INBOX_WIDGET_URL || "").replace(/\/$/, "");
const TG_BOT = import.meta.env.VITE_INBOX_TELEGRAM_BOT || ""; // имя бота без @, например inbox_layero_bot
const BUCKET = "screenshots";
const APP_URL = `${location.origin}/dashboard/`; // кабинет живёт на /dashboard/ рядом с лендингом
const POLL_MS = 15000; // realtime на платформе нет — опрашиваем

const KIND = { problem: "проблема", lead: "заявка", booking: "запись" };
const KIND_MANY = { problem: "Проблемы", lead: "Заявки", booking: "Записи" };
const FORM_TITLE = { problem: "Сообщить о проблеме", lead: "Оставить заявку", booking: "Записаться" };
const VIEWS = { open: ["new", "in_progress"], resolved: ["resolved"], rejected: ["rejected"] };
const WEEK = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const root = document.getElementById("root");

const state = {
  user: null,
  sites: [],
  siteId: null,
  view: "reports",          // reports | settings | new-site
  kind: "all",
  status: "open",
  reports: [],
  reportId: null,
  shotUrls: {},             // путь → подписанная ссылка
  members: [], invites: [],
  counts: {},
  tg: null,                 // { code, status, error } — подключение Telegram
  flash: "",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const site = () => state.sites.find((s) => s.id === state.siteId);
const isOwner = () => site()?.owner_id === state.user?.id;

function ago(d) {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 1) return "сейчас";
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч`;
  return new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
function when(iso, tz) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: tz || "Europe/Moscow", weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
    .format(new Date(iso));
}
function shortUrl(u) {
  try { const x = new URL(u); return x.host + (x.pathname === "/" ? "" : x.pathname); } catch { return u || ""; }
}
function title(r) {
  if (r.kind === "lead") return [r.name, r.contact].filter(Boolean).join(" · ");
  if (r.kind === "booking") return `${r.name || "Гость"} · ${when(r.booking_at, site()?.timezone)}`;
  return r.message;
}
function sub(r) {
  if (r.kind === "lead") return `заявка${r.message ? ` · «${r.message.slice(0, 60)}»` : ""}`;
  if (r.kind === "booking") return `запись · ${r.contact}`;
  return ["проблема", shortUrl(r.page_url), r.viewport, r.screenshot_path ? "снимок" : ""].filter(Boolean).join(" · ");
}

/* ---------- вход ---------- */

// Какие внешние входы включены у базы (как /settings у GoTrue): кнопку
// «Войти с Яндекс ID» показываем, только когда провайдер подключён в панели.
let providers = {};
const providersReady = fetch(`${DATA_URL}/auth/v1/settings`, { headers: { apikey: DATA_KEY } })
  .then((r) => r.json()).then((s) => (providers = s.external || {})).catch(() => {});

function renderAuth(mode = "login", msg = "") {
  const titles = { login: "Войти", signup: "Создать кабинет", recover: "Новый пароль" };
  root.innerHTML = `
    <div class="auth">
      <section class="auth-hero">
        <a class="brand" href="/dashboard/"><span>inbox</span><i></i><small>by layero</small></a>
        <h2>Всё, что хотят сказать ваши пользователи,&nbsp;— здесь</h2>
        <p>сообщения о&nbsp;проблемах со&nbsp;снимком экрана<br>заявки с&nbsp;контактами<br>онлайн-записи на&nbsp;свободное время<br>уведомления о&nbsp;новых&nbsp;— в&nbsp;Telegram</p>
      </section>
      <section class="auth-side">
        <form class="auth-form" id="auth-form">
          <h1>${titles[mode]}</h1>
          ${mode !== "recover" && providers.yandex ? `<button class="btn" type="button" id="yandex"><span class="ya">Я</span>Войти с&nbsp;Яндекс&nbsp;ID</button>
            <div class="or">или почтой</div>` : ""}
          <label>Почта<input name="email" type="email" required autocomplete="email" placeholder="you@company.ru"></label>
          ${mode !== "recover" ? `<label>Пароль<input name="password" type="password" required minlength="8"
              autocomplete="${mode === "signup" ? "new-password" : "current-password"}"></label>` : ""}
          ${msg ? `<p class="${msg.startsWith("✓") ? "ok" : "error"}">${esc(msg)}</p>` : ""}
          <button class="btn ${mode !== "recover" && providers.yandex ? "line" : ""}" type="submit">${{ login: "Войти по паролю", signup: "Создать кабинет", recover: "Прислать ссылку" }[mode]}</button>
          <p class="switch">
            ${mode === "login" ? `Первый раз? <button type="button" class="linkbtn" data-mode="signup">Создать кабинет</button> · <button type="button" class="linkbtn" data-mode="recover">Забыли пароль?</button>`
              : `Уже есть кабинет? <button type="button" class="linkbtn" data-mode="login">Войти</button>`}
          </p>
        </form>
      </section>
    </div>`;
  root.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => renderAuth(b.dataset.mode)));
  const ya = root.querySelector("#yandex");
  if (ya) ya.onclick = async () => {
    // Регистрация и вход — одно действие: новый человек заводится сам.
    const { error } = await db.auth.signInWithOAuth({ provider: "yandex", options: { redirectTo: APP_URL } });
    if (error) renderAuth(mode, humanAuthError(error));
  };
  root.querySelector("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const email = String(f.get("email")).trim().toLowerCase();
    const password = String(f.get("password") || "");
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      if (mode === "login") {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await db.auth.signUp({ email, password, options: { emailRedirectTo: APP_URL } });
        if (error) throw error;
        if (!data.session) return renderAuth("login", `✓ Письмо ушло на ${email}. Откройте ссылку из него и войдите.`);
      } else {
        const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
        if (error) throw error;
        return renderAuth("login", "✓ Если такой кабинет есть, письмо со ссылкой уже в пути.");
      }
    } catch (err) {
      renderAuth(mode, humanAuthError(err));
    } finally {
      btn.disabled = false;
    }
  };
}

function humanAuthError(err) {
  const m = err?.message || String(err);
  if (/invalid login credentials/i.test(m)) return "Неверная почта или пароль.";
  if (/email not confirmed/i.test(m)) return "Почта ещё не подтверждена — откройте ссылку из письма.";
  if (/already registered|already exists/i.test(m)) return "Такой кабинет уже есть — войдите.";
  return m;
}

/* ---------- данные ---------- */

async function loadSites() {
  const { data, error } = await db.from("sites").select("*").order("created_at");
  if (error) throw error;
  state.sites = data;
  if (!state.sites.find((s) => s.id === state.siteId)) state.siteId = state.sites[0]?.id ?? null;
  const { data: fresh } = await db.from("reports").select("site_id").eq("status", "new").limit(1000);
  state.counts = {};
  (fresh || []).forEach((r) => (state.counts[r.site_id] = (state.counts[r.site_id] || 0) + 1));
}

async function loadReports() {
  if (!state.siteId) return (state.reports = []);
  const { data, error } = await db.from("reports").select("*").eq("site_id", state.siteId)
    .in("status", VIEWS[state.status]).order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  state.reports = data;
}

async function loadTeam() {
  const [{ data: m }, { data: i }] = await Promise.all([
    db.from("site_members").select("*").eq("site_id", state.siteId).order("created_at"),
    isOwner() ? db.from("invites").select("*").eq("site_id", state.siteId).is("accepted_at", null).order("created_at") : { data: [] },
  ]);
  state.members = m || [];
  state.invites = i || [];
}

async function shotUrl(path) {
  if (!path) return null;
  if (state.shotUrls[path]) return state.shotUrls[path];
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error) return { error: error.message };
  state.shotUrls[path] = data.signedUrl;
  return data.signedUrl;
}

async function updateSite(patch) {
  const { error } = await db.from("sites").update(patch).eq("id", state.siteId);
  await loadSites();
  return error;
}

/* ---------- оболочка ---------- */

function renderShell(content) {
  root.innerHTML = `
    <div class="shell">
      <aside class="side">
        <a class="brand" href="/dashboard/"><span>inbox</span><i></i><small>by layero</small></a>
        <nav aria-label="Сайты">
          <span class="label">Сайты</span>
          ${state.sites.map((s) => `<button class="site-link" data-site="${s.id}" aria-current="${s.id === state.siteId && state.view !== "new-site"}">
            <span>${esc(s.name)}</span>${state.counts[s.id] ? `<span class="count">${state.counts[s.id]}</span>` : ""}</button>`).join("")}
        </nav>
        <button class="add-site" id="add-site">+ Подключить сайт</button>
        <div class="me">${esc(state.user.email)}<button class="linkbtn" id="logout">Выйти</button></div>
      </aside>
      <main class="main">${content}</main>
    </div>`;
  root.querySelectorAll("[data-site]").forEach((b) => (b.onclick = () => go({ siteId: b.dataset.site, view: "reports", reportId: null, flash: "" })));
  root.querySelector("#add-site").onclick = () => go({ view: "new-site" });
  root.querySelector("#logout").onclick = async () => { await db.auth.signOut(); };
}

function renderNewSite(msg = "") {
  renderShell(`
    <div class="top"><h1>${state.sites.length ? "Новый сайт" : "Подключите первый сайт"}</h1></div>
    <form class="panel" id="site-form" style="max-width: 640px">
      <label class="f">Название<input name="name" required maxlength="80" placeholder="Магазин «Заря»"></label>
      <label class="f">Домен<input name="domain" maxlength="255" placeholder="shop.zarya.ru"></label>
      ${msg ? `<p class="error">${esc(msg)}</p>` : ""}
      <div class="inline"><button class="btn" type="submit">Подключить</button></div>
      <p class="note">Дальше покажем строку для сайта и&nbsp;кнопку Telegram.</p>
    </form>`);
  root.querySelector("#site-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { data, error } = await db.from("sites")
      .insert({ name: String(f.get("name")).trim(), domain: String(f.get("domain")).trim() || null, owner_id: state.user.id })
      .select().single();
    if (error) return renderNewSite(error.message);
    state.siteId = data.id;
    await loadSites();
    await go({ view: "settings" });
  };
}

/* ---------- входящие ---------- */

function renderReports() {
  const s = site();
  if (!s) return renderNewSite();
  const fresh = state.counts[s.id] || 0;
  const byKind = { all: state.reports.length };
  for (const k of Object.keys(KIND)) byKind[k] = state.reports.filter((r) => r.kind === k).length;
  const list = state.kind === "all" ? state.reports : state.reports.filter((r) => r.kind === state.kind);
  const r = list.find((x) => x.id === state.reportId);
  renderShell(`
    <div class="top">
      <div class="title-row"><h1>${esc(s.name)}</h1>${fresh ? `<span class="badge"><b>${fresh}</b>${fresh === 1 ? "новое" : "новых"}</span>` : ""}</div>
      <button class="btn line" id="settings">Установка, Telegram и&nbsp;команда</button>
    </div>
    <div class="bar">
      <div class="chips">${[["all", "Всё"], ...Object.entries(KIND_MANY)].map(([k, v]) =>
        `<button data-kind="${k}" aria-pressed="${state.kind === k}">${v} · ${byKind[k]}</button>`).join("")}</div>
      <div class="tabs">${[["open", "Открытые"], ["resolved", "Готово"], ["rejected", "Отклонено"]].map(([k, v]) =>
        `<button data-status="${k}" aria-pressed="${state.status === k}">${v}</button>`).join("")}</div>
    </div>
    <div class="layout">
      <div class="list">${list.length ? list.map((x) => `
        <button class="row ${x.status === "new" ? "unread" : ""}" data-report="${x.id}" aria-current="${x.id === state.reportId}">
          <span class="dot ${x.status === "new" ? "" : "read"}" aria-label="${x.status === "new" ? "не прочитано" : "прочитано"}"></span>
          <span><span class="t">${esc(title(x))}</span><span class="s">${esc(sub(x))}${x.status === "in_progress" ? " · в работе" : ""}</span></span>
          <span class="w">${ago(x.created_at)}</span>
        </button>`).join("")
        : `<div class="empty"><b>${state.status === "open" ? "Пусто. Так и задумано." : "Здесь пока ничего."}</b>${state.status === "open" ? "Новое появится здесь и&nbsp;в&nbsp;Telegram." : ""}</div>`}</div>
      ${r ? renderDetail(r) : `<section class="detail quiet"><p>Выберите сообщение слева.</p></section>`}
    </div>`);
  root.querySelector("#settings").onclick = () => go({ view: "settings", flash: "" });
  root.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => go({ kind: b.dataset.kind, reportId: null })));
  root.querySelectorAll("[data-status]").forEach((b) => (b.onclick = () => go({ status: b.dataset.status, reportId: null })));
  root.querySelectorAll("[data-report]").forEach((b) => (b.onclick = () => go({ reportId: b.dataset.report })));
  if (!r) return;
  root.querySelectorAll("[data-set]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const { error } = await db.from("reports").update({ status: b.dataset.set }).eq("id", r.id);
    if (error) alert(`Статус не сохранился: ${error.message}`);
    await loadSites();
    await go(b.dataset.set === "in_progress" ? {} : { reportId: null });
  }));
  const del = root.querySelector("#delete");
  if (del) del.onclick = async () => {
    if (!confirm("Удалить сообщение? Вернуть не получится.")) return;
    const { error } = await db.from("reports").delete().eq("id", r.id);
    if (error) return alert(error.message);
    if (r.screenshot_path) await db.storage.from(BUCKET).remove([r.screenshot_path]);
    await loadSites();
    await go({ reportId: null });
  };
  if (r.screenshot_path) shotUrl(r.screenshot_path).then((u) => {
    const box = root.querySelector("#shot");
    if (!box || state.reportId !== r.id) return;
    box.innerHTML = typeof u === "string"
      ? `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Снимок экрана посетителя"></a>`
      : `<div class="ph">снимок недоступен: ${esc(u?.error || "не загрузился")}</div>`;
  });
}

function renderDetail(r) {
  const s = site();
  const actions = r.status === "new" ? [["in_progress", "Взять в работу", "btn"], ["resolved", "Готово", "btn line"], ["rejected", "Отклонить", "btn plain"]]
    : r.status === "in_progress" ? [["resolved", "Готово", "btn"], ["rejected", "Отклонить", "btn plain"]]
    : [["in_progress", "Вернуть в работу", "btn line"]];
  const contact = r.contact ? (/@/.test(r.contact) ? `<a href="mailto:${esc(r.contact)}">${esc(r.contact)}</a>` : `<a class="mono" href="tel:${esc(r.contact.replace(/[^\d+]/g, ""))}">${esc(r.contact)}</a>`) : "—";
  let body = "";
  if (r.kind === "booking") {
    body = `<div class="big-when">${esc(when(r.booking_at, s?.timezone))}</div>
      <dl><dt>Имя</dt><dd>${esc(r.name || "—")}</dd><dt>Контакт</dt><dd>${contact}</dd><dt>Согласие</dt><dd>${r.consent_at ? "дано" : "—"}</dd></dl>`;
  } else if (r.kind === "lead") {
    body = `<h2>${esc(r.name || "Без имени")}</h2>
      <dl><dt>Контакт</dt><dd>${contact}</dd><dt>Вопрос</dt><dd>${esc(r.message || "—")}</dd><dt>Страница</dt><dd>${r.page_url ? `<a href="${esc(r.page_url)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(r.page_url))}</a>` : "—"}</dd><dt>Согласие</dt><dd>${r.consent_at ? "дано" : "—"}</dd></dl>`;
  } else {
    body = `<h2>${esc(r.message)}</h2>
      <div class="shot" id="shot">${r.screenshot_path ? `<div class="ph">загружаем снимок…</div>` : `<div class="ph">без снимка экрана</div>`}</div>
      <dl><dt>Страница</dt><dd>${r.page_url ? `<a href="${esc(r.page_url)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(r.page_url))}</a>` : "—"}</dd>
        <dt>Устройство</dt><dd class="mono">${esc([r.viewport, r.language].filter(Boolean).join(" · ") || "—")}</dd>
        <dt>Браузер</dt><dd class="mono" style="font-size: 12px">${esc(r.user_agent || "—")}</dd>
        <dt>Ответить</dt><dd>${contact}</dd></dl>`;
  }
  return `<article class="detail">
    <div class="head"><span class="label">${KIND[r.kind]} · ${ago(r.created_at)}${r.status === "in_progress" ? " · в работе" : ""}</span>${r.status === "new" ? `<span class="dot" aria-hidden="true"></span>` : ""}</div>
    ${body}
    <div class="actions">${actions.map(([st, t, c]) => `<button class="${c}" data-set="${st}">${t}</button>`).join("")}
      ${isOwner() ? `<button class="btn plain" id="delete">Удалить</button>` : ""}</div>
  </article>`;
}

/* ---------- настройки сайта ---------- */

function renderSettings() {
  const s = site();
  if (!s) return renderNewSite();
  const owner = isOwner();
  const forms = s.forms || ["problem"];
  const snippet = `<script src="${WIDGET_URL}/embed.js" data-site="${s.site_key}" async></script>`;
  const tg = state.tg;
  renderShell(`
    <div class="wrap">
      <div class="top"><div style="display: flex; flex-direction: column; gap: 10px"><button class="linkbtn" id="back" style="align-self: flex-start; color: var(--graphite)">← Входящие</button><h1>${esc(s.name)}</h1></div>
        <span class="label">ключ ${esc(s.site_key.slice(0, 11))}…</span></div>
      ${state.flash ? `<p class="${state.flash.startsWith("✓") ? "ok" : "error"}">${esc(state.flash)}</p>` : ""}

      <section class="tg">
        <div style="display: flex; flex-direction: column; gap: 16px; justify-content: space-between">
          <div style="display: flex; flex-direction: column; gap: 10px">
            <span class="label">Telegram</span>
            <h2>${s.telegram_chat_id ? "Точка горит у&nbsp;вас в&nbsp;кармане" : "Точка загорится у&nbsp;вас в&nbsp;кармане"}</h2>
            <p>${s.telegram_chat_id ? "Новые проблемы, заявки и&nbsp;записи приходят в&nbsp;этот чат." : "Одна кнопка. Откроется бот, нажмёте «Старт»&nbsp;— и&nbsp;сообщения с&nbsp;сайта пойдут в&nbsp;Telegram. Номер чата искать не&nbsp;нужно."}</p>
          </div>
          ${!TG_BOT ? `<p class="note" style="color: #b8b6ad">Telegram не настроен: задайте переменную VITE_INBOX_TELEGRAM_BOT и секрет TELEGRAM_BOT_TOKEN.</p>` : owner ? (tg?.status === "waiting"
            ? `<div style="display: flex; flex-direction: column; gap: 10px"><div class="wait"><i></i>Ждём «Старт» в&nbsp;Telegram…</div>
                <div class="inline"><a class="btn yellow" href="https://t.me/${esc(TG_BOT)}?start=${esc(tg.code)}" target="_blank" rel="noopener">Открыть бота ещё раз</a><button class="btn plain" id="tg-cancel">Отмена</button></div></div>`
            : `<div class="inline" style="align-items: center"><button class="btn yellow" id="tg-connect">${s.telegram_chat_id ? "Подключить другой чат →" : "Подключить Telegram →"}</button><span class="label">@${esc(TG_BOT)}</span></div>`)
            : `<p class="note" style="color: #b8b6ad">Telegram подключает владелец сайта.</p>`}
          ${tg?.error ? `<p class="error" style="color: #ffb4a8">${esc(tg.error)}</p>` : ""}
        </div>
        <div class="tg-box">
          <span class="label">${s.telegram_chat_id ? "подключено" : "после подключения"}</span>
          <div class="tg-chat"><span class="ava">${esc((s.telegram_chat_title || "?").slice(0, 1))}</span>
            <div style="display: flex; flex-direction: column; gap: 3px"><b>${esc(s.telegram_chat_title || (s.telegram_chat_id ? "Чат Telegram" : "Здесь будет ваш чат"))}</b>
            <span class="mono" style="font-size: 12px; color: #b8b6ad">${s.telegram_chat_id ? "сообщения идут сюда" : "пока не подключено"}</span></div>
            ${s.telegram_chat_id ? `<span class="live" aria-hidden="true"></span>` : ""}</div>
          ${Object.entries(KIND_MANY).map(([k, v]) => `<label><input type="checkbox" data-notify="${k}" ${(s.notify_kinds || []).includes(k) ? "checked" : ""} ${owner && s.telegram_chat_id ? "" : "disabled"}>${v}${k === "problem" ? "&nbsp;— с&nbsp;фото снимка" : ""}</label>`).join("")}
          ${owner && s.telegram_chat_id ? `<div class="inline" style="margin-top: auto"><button class="btn line" id="tg-test">Прислать пробное</button><button class="btn plain" id="tg-off">Отключить</button></div>` : ""}
        </div>
      </section>

      <section class="panel"><div class="grid2">
        <div style="display: flex; flex-direction: column; gap: 12px">
          <span class="label">Формы на&nbsp;сайте</span>
          ${[["problem", "со&nbsp;снимком экрана"], ["lead", "имя, телефон или&nbsp;почта, согласие на&nbsp;обработку"], ["booking", "свободные слоты из&nbsp;расписания"]].map(([k, d]) => `
            <label class="toggle"><span><b>${FORM_TITLE[k]}</b><small>${d}</small></span><input type="checkbox" data-form="${k}" ${forms.includes(k) ? "checked" : ""} ${owner ? "" : "disabled"}></label>`).join("")}
        </div>
        <form id="schedule" style="display: flex; flex-direction: column; gap: 12px">
          <span class="label">Расписание записи</span>
          <div class="weekdays">${WEEK.map((d, i) => `<button type="button" data-day="${i + 1}" aria-pressed="${(s.booking_days || []).includes(i + 1)}" ${owner ? "" : "disabled"}>${d}</button>`).join("")}</div>
          <div class="trio">
            <label>С<input name="from" type="time" value="${esc((s.booking_from || "10:00").slice(0, 5))}" ${owner ? "" : "disabled"}></label>
            <label>До<input name="to" type="time" value="${esc((s.booking_to || "19:00").slice(0, 5))}" ${owner ? "" : "disabled"}></label>
            <label>Слот, мин<input name="slot" type="number" min="15" max="480" step="15" value="${s.booking_slot_minutes || 60}" ${owner ? "" : "disabled"}></label>
          </div>
          ${owner ? `<div class="inline"><button class="btn line" type="submit">Сохранить расписание</button></div>` : ""}
          <p class="note">Занятый слот пропадает из&nbsp;формы сразу после записи. Время&nbsp;— ${esc(s.timezone)}.</p>
        </form>
      </div></section>

      <section class="panel soft">
        <span class="label">Установка</span>
        <div class="top" style="align-items: center"><h2>Одна строка перед &lt;/body&gt;</h2><button class="btn" id="copy">Скопировать</button></div>
        <pre class="snippet"><s>&lt;script</s> src=<em>"${esc(WIDGET_URL)}/embed.js"</em> data-site=<em>"${esc(s.site_key)}"</em> async<s>&gt;&lt;/script&gt;</s></pre>
        <p class="note">Плавающая кнопка открывает «${FORM_TITLE.problem}»; другую форму на&nbsp;кнопке&nbsp;— <code>data-form="lead"</code> или <code>"booking"</code>. Своя кнопка в&nbsp;любом месте страницы: <code>&lt;button data-inbox="booking"&gt;Записаться&lt;/button&gt;</code></p>
      </section>

      ${owner ? `<form class="panel" id="site-form">
        <span class="label">Сайт</span>
        <div class="grid2" style="gap: 12px">
          <label class="f">Название<input name="name" required maxlength="80" value="${esc(s.name)}"></label>
          <label class="f">Домен<input name="domain" maxlength="255" value="${esc(s.domain || "")}"></label>
        </div>
        <div class="inline"><button class="btn line" type="submit">Сохранить</button></div>
      </form>` : ""}

      <section class="panel">
        <span class="label">Команда</span>
        <ul class="people">
          ${state.members.map((m) => `<li><span>${esc(m.email || m.user_id)}</span>
            ${m.role === "owner" ? `<span class="label">владелец</span>` : (owner || m.user_id === state.user.id)
              ? `<button class="btn plain" data-unmember="${m.user_id}">${m.user_id === state.user.id ? "Выйти" : "Убрать"}</button>` : ""}</li>`).join("")}
          ${state.invites.map((i) => `<li><span style="color: var(--graphite)">${esc(i.email)} · ждём первого входа</span><button class="btn plain" data-uninvite="${i.id}">Отозвать</button></li>`).join("")}
        </ul>
        ${owner ? `<form class="inline" id="invite-form"><label style="display: contents"><span hidden>Почта коллеги</span><input name="email" type="email" required placeholder="почта коллеги" aria-label="Почта коллеги"></label><button class="btn" type="submit">Позвать</button></form>
          <p class="note">Письмо не&nbsp;отправляем&nbsp;— передайте коллеге ссылку на&nbsp;кабинет: ${esc(APP_URL)}</p>` : ""}
      </section>

      ${owner ? `<section class="panel"><span class="label">Удалить сайт</span><p class="note">Вместе с&nbsp;сайтом удалятся все его сообщения.</p>
        <div class="inline"><button class="btn danger" id="del-site">Удалить «${esc(s.name)}»</button></div></section>` : ""}
    </div>`);

  const $ = (sel) => root.querySelector(sel);
  $("#back").onclick = () => go({ view: "reports", flash: "" });
  $("#copy").onclick = async (e) => { await navigator.clipboard.writeText(snippet); e.target.textContent = "Скопировано"; };
  const flash = (error, ok) => go({ flash: error ? (error.message || String(error)) : ok });

  // Telegram одной кнопкой: код → бот → «Старт» → опрос api.telegram_link_check.
  const connect = $("#tg-connect");
  if (connect) connect.onclick = async () => {
    const tab = window.open("about:blank", "_blank"); // открываем сразу, иначе браузер заблокирует
    const { data, error } = await db.rpc("telegram_link_start", { site_id: s.id });
    if (error) { tab?.close(); state.tg = { error: error.message }; return renderSettings(); }
    const url = `https://t.me/${TG_BOT}?start=${data.code}`;
    if (tab) tab.location.href = url; else window.open(url, "_blank");
    state.tg = { code: data.code, status: "waiting", site: s.id };
    renderSettings();
    pollTelegram();
  };
  const cancel = $("#tg-cancel");
  if (cancel) cancel.onclick = () => { state.tg = null; renderSettings(); };
  const test = $("#tg-test");
  if (test) test.onclick = async () => {
    const { error } = await db.rpc("telegram_test", { site_id: s.id });
    flash(error, "✓ Пробное сообщение ушло в Telegram");
  };
  const off = $("#tg-off");
  if (off) off.onclick = async () => {
    if (!confirm("Отключить Telegram? Сообщения перестанут приходить в чат.")) return;
    flash(await updateSite({ telegram_chat_id: null, telegram_chat_title: null }), "✓ Telegram отключён");
  };
  root.querySelectorAll("[data-notify]").forEach((c) => (c.onchange = async () => {
    const kinds = [...root.querySelectorAll("[data-notify]:checked")].map((x) => x.dataset.notify);
    flash(await updateSite({ notify_kinds: kinds }), "✓ Сохранено");
  }));
  root.querySelectorAll("[data-form]").forEach((c) => (c.onchange = async () => {
    const list = [...root.querySelectorAll("[data-form]:checked")].map((x) => x.dataset.form);
    if (!list.length) { c.checked = true; return flash(null, "Хотя бы одна форма должна остаться включённой"); }
    flash(await updateSite({ forms: list }), "✓ Формы сохранены");
  }));
  root.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () =>
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"))));
  const sch = $("#schedule");
  if (owner) sch.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(sch);
    const days = [...root.querySelectorAll("[data-day][aria-pressed=true]")].map((b) => Number(b.dataset.day));
    if (String(f.get("to")) <= String(f.get("from"))) return flash(null, "Время «до» должно быть позже «с».");
    flash(await updateSite({ booking_days: days, booking_from: f.get("from"), booking_to: f.get("to"),
      booking_slot_minutes: Number(f.get("slot")) || 60 }), "✓ Расписание сохранено");
  };
  const sf = $("#site-form");
  if (sf) sf.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(sf);
    flash(await updateSite({ name: String(f.get("name")).trim(), domain: String(f.get("domain")).trim() || null }), "✓ Сохранено");
  };
  const inv = $("#invite-form");
  if (inv) inv.onsubmit = async (e) => {
    e.preventDefault();
    const email = String(new FormData(inv).get("email")).trim().toLowerCase();
    const { error } = await db.from("invites").insert({ site_id: s.id, email, invited_by: state.user.id });
    flash(error && (error.code === "23505" ? { message: "Этого человека уже звали." } : error), `✓ ${email} увидит сайт после входа`);
  };
  root.querySelectorAll("[data-uninvite]").forEach((b) => (b.onclick = async () => {
    await db.from("invites").delete().eq("id", b.dataset.uninvite);
    go({});
  }));
  root.querySelectorAll("[data-unmember]").forEach((b) => (b.onclick = async () => {
    const { error } = await db.from("site_members").delete().eq("site_id", s.id).eq("user_id", b.dataset.unmember);
    if (error) return flash(error);
    if (b.dataset.unmember === state.user.id) { await loadSites(); return go({ view: "reports" }); }
    go({});
  }));
  const ds = $("#del-site");
  if (ds) ds.onclick = async () => {
    if (prompt(`Чтобы удалить сайт, введите его название: ${s.name}`) !== s.name) return;
    const { error } = await db.from("sites").delete().eq("id", s.id);
    if (error) return flash(error);
    state.siteId = null;
    await loadSites();
    go({ view: "reports", flash: "" });
  };
}

let tgTimer = null;
function pollTelegram() {
  clearTimeout(tgTimer);
  tgTimer = setTimeout(async () => {
    const tg = state.tg;
    if (!tg || tg.status !== "waiting") return;
    const { data, error } = await db.rpc("telegram_link_check", { code: tg.code });
    if (state.tg !== tg) return;
    if (error) { state.tg = { error: error.message }; }
    else if (data.status === "linked") { state.tg = null; await loadSites(); state.flash = `✓ Telegram подключён: ${data.chat_title || "чат"}`; }
    else if (data.status === "expired" || data.status === "unknown") { state.tg = { error: "Код устарел — нажмите кнопку ещё раз." }; }
    else return pollTelegram();
    if (state.view === "settings" && state.siteId === tg.site) renderSettings();
  }, 2000);
}

/* ---------- навигация ---------- */

async function go(patch = {}) {
  Object.assign(state, patch);
  try {
    if (state.view === "new-site") return renderNewSite();
    if (state.view === "settings") { await loadTeam(); return renderSettings(); }
    await loadReports();
    renderReports();
  } catch (err) {
    root.innerHTML = `<div class="loading"><p class="error">${esc(err.message)}</p><button class="btn" onclick="location.reload()">Обновить</button></div>`;
  }
}

let lastSnapshot = "";
async function refresh() {
  if (!state.user || state.view !== "reports") return;
  await loadSites();
  await loadReports();
  // Перерисовываем только при изменениях: иначе опрос сбивает фокус.
  const snapshot = JSON.stringify([state.sites, state.counts, state.reports]);
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  renderReports();
}

/* ---------- старт ---------- */

let timer = null;
async function onSession(session) {
  clearInterval(timer);
  if (!session) {
    state.user = null;
    await providersReady;
    return renderAuth();
  }
  if (state.user?.id === session.user.id) return;
  state.user = session.user;
  await db.rpc("accept_invites"); // приглашения на эту почту
  await loadSites();
  await go({ view: state.sites.length ? "reports" : "new-site" });
  timer = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
}

db.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => onSession(session), 0); // не звать API внутри колбэка supabase-js
});
