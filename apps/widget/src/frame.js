// Формы Layero Inbox внутри iframe. Живут на нашем домене, поэтому Data API
// их пускает. Ключ публичный (роль anon): он открывает только api.site_form,
// api.submit_form, загрузку снимка по выданному пути и api.notify_screenshot.
const DATA_URL = import.meta.env.VITE_LAYERO_DATA_URL;
const DATA_KEY = import.meta.env.VITE_LAYERO_DATA_KEY;
const BUCKET = "screenshots";
const KINDS = { problem: "проблема", lead: "заявка", booking: "запись" };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const siteKey = params.get("site");
let form = KINDS[params.get("form")] ? params.get("form") : "problem";
const parentWin = window.parent !== window ? window.parent : null;
let ctx = { page_url: document.referrer || null };
let site = null;          // ответ api.site_form
let pickedDay = null;
let pickedSlot = null;

function post(msg) {
  // Хозяина страницы мы не знаем заранее, а секретов в сообщениях нет.
  if (parentWin) parentWin.postMessage(msg, "*");
}

async function rpc(fn, args) {
  const r = await fetch(`${DATA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: DATA_KEY },
    body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message || body?.error || `HTTP ${r.status}`);
  return body;
}

async function upload(path, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const r = await fetch(`${DATA_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: DATA_KEY, authorization: `Bearer ${DATA_KEY}`, "content-type": "image/jpeg" },
    body: blob,
  });
  if (!r.ok) throw new Error(`снимок не загрузился: HTTP ${r.status}`);
}

// Ссылка на только что загруженный снимок — чтобы Telegram скачал его сам.
async function signedUrl(path) {
  const r = await fetch(`${DATA_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: DATA_KEY, authorization: `Bearer ${DATA_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!r.ok) throw new Error(`ссылка на снимок не получена: HTTP ${r.status}`);
  return `${DATA_URL}/storage/v1${(await r.json()).signedURL}`;
}

const HUMAN = {
  "unknown site key": "Ключ сайта не найден. Проверьте строку установки.",
  "form is off for this site": "Эта форма на сайте выключена.",
  "message is empty": "Напишите хотя бы пару слов.",
  "contact is empty": "Оставьте телефон или почту.",
  "consent is required": "Без согласия на обработку данных отправить нельзя.",
  "slot is not available": "Это время только что заняли. Выберите другое.",
  "too many reports, try later": "Слишком много сообщений подряд. Попробуйте через минуту.",
};

function showError(f, text) {
  const el = f.querySelector(".error");
  el.textContent = text;
  el.hidden = !text;
}

function show(kind) {
  form = kind;
  for (const k of Object.keys(KINDS)) $(`form-${k}`).hidden = k !== kind;
  document.body.classList.toggle("booking", kind === "booking");
  $("kind").textContent = KINDS[kind];
  if (kind === "booking") renderSlots();
}

/* ---------- запись: дни и время в часовом поясе сайта ---------- */

function slotsByDay() {
  const tz = site?.timezone || "Europe/Moscow";
  const day = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const map = new Map();
  for (const iso of site?.slots || []) {
    const d = new Date(iso);
    const key = day.format(d);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(iso);
  }
  return { map, tz };
}

function renderSlots() {
  const { map, tz } = slotsByDay();
  const days = [...map.keys()].slice(0, 10);
  $("slots-note").hidden = days.length > 0;
  if (!pickedDay || !map.has(pickedDay)) pickedDay = days[0] || null;
  const wd = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, weekday: "short" });
  const dn = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, day: "numeric" });
  $("days").replaceChildren(...days.map((key) => {
    const first = new Date(map.get(key)[0]);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("aria-pressed", String(key === pickedDay));
    b.innerHTML = `${wd.format(first)}<b>${dn.format(first)}</b>`;
    b.onclick = () => { pickedDay = key; pickedSlot = null; renderSlots(); };
    return b;
  }));
  const tm = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  $("times").replaceChildren(...(map.get(pickedDay) || []).map((iso) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip time";
    b.setAttribute("aria-pressed", String(iso === pickedSlot));
    b.textContent = tm.format(new Date(iso));
    b.onclick = () => { pickedSlot = iso; renderSlots(); };
    return b;
  }));
  const send = $("book-send");
  send.disabled = !pickedSlot;
  send.textContent = pickedSlot ? `${slotLabel(pickedSlot)} →` : "Выберите время";
}

function slotLabel(iso) {
  const tz = site?.timezone || "Europe/Moscow";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
    .format(new Date(iso)).replace(/^./, (c) => c.toUpperCase());
}

/* ---------- отправка ---------- */

function base() {
  return {
    site_key: siteKey,
    form,
    page_url: ctx.page_url || null,
    user_agent: ctx.user_agent || navigator.userAgent,
    viewport: ctx.viewport || null,
    language: ctx.language || navigator.language,
  };
}

function done(title, text) {
  for (const k of Object.keys(KINDS)) $(`form-${k}`).hidden = true;
  $("done-title").textContent = title;
  $("done-text").textContent = text;
  $("done").hidden = false;
  $("done-close").focus();
}

async function submit(f, args, after) {
  const btn = f.querySelector(".send");
  const label = btn.textContent;
  showError(f, "");
  btn.disabled = true;
  btn.textContent = "Отправляем…";
  try {
    const res = await rpc("submit_form", { ...base(), ...args });
    await after?.(res);
    return true;
  } catch (err) {
    showError(f, HUMAN[err.message] || `Не получилось отправить: ${err.message}`);
    if (err.message === "slot is not available") await refreshSite();
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    if (form === "booking") renderSlots();
  }
}

$("form-problem").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const message = f.message.value.trim();
  if (!message) return showError(f, HUMAN["message is empty"]);
  const withShot = Boolean(ctx.screenshot) && $("shot-on").checked;
  const ok = await submit(f, { message, contact: f.contact.value.trim() || null, has_screenshot: withShot }, async (res) => {
    if (!withShot || !res.upload_path) return;
    // Со снимком владелец получает фото после загрузки; не загрузился — текст.
    let url = null;
    try {
      await upload(res.upload_path, ctx.screenshot);
      url = await signedUrl(res.upload_path);
    } catch (err) {
      console.warn("[Layero Inbox]", err); // обращение уже принято, снимок — бонус
    }
    await rpc("notify_screenshot", { report_id: res.id, signed_url: url }).catch((err) =>
      console.warn("[Layero Inbox] уведомление:", err));
  });
  if (ok) done("Отправлено.", "Владелец сайта уже видит ваше сообщение" + (withShot ? " и снимок." : "."));
});

$("form-lead").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.contact.value.trim()) return showError(f, HUMAN["contact is empty"]);
  if (!f.consent.checked) return showError(f, HUMAN["consent is required"]);
  const ok = await submit(f, {
    name: f.name.value.trim() || null, contact: f.contact.value.trim(),
    message: f.message.value.trim() || null, consent: true,
  });
  if (ok) done("Заявка у нас.", "Вам ответят по оставленному контакту.");
});

$("form-booking").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!pickedSlot) return showError(f, "Выберите день и время.");
  if (!f.contact.value.trim()) return showError(f, HUMAN["contact is empty"]);
  if (!f.consent.checked) return showError(f, HUMAN["consent is required"]);
  const slot = pickedSlot;
  const ok = await submit(f, { name: f.name.value.trim() || null, contact: f.contact.value.trim(), booking_at: slot, consent: true });
  if (ok) done("Вы записаны.", `${slotLabel(slot)}. Если планы изменятся — позвоните или напишите на сайте.`);
});

/* ---------- старт ---------- */

async function refreshSite() {
  site = await rpc("site_form", { site_key: siteKey });
}

window.addEventListener("message", (e) => {
  if (e.source !== parentWin || !e.data || e.data.type !== "li:init") return;
  ctx = e.data;
  if (ctx.form && KINDS[ctx.form]) show(ctx.form);
  if (ctx.screenshot) {
    $("shot-img").src = ctx.screenshot;
    $("shot").hidden = false;
  }
  $("meta").textContent = [ctx.page_url, ctx.viewport].filter(Boolean).join(" · ");
});

for (const id of ["close", "done-close"]) $(id).addEventListener("click", () => post({ type: "li:close" }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") post({ type: "li:close" }); });

show(form);
if (!siteKey) {
  showError($(`form-${form}`), "Виджет установлен без ключа сайта.");
} else {
  refreshSite().then(() => {
    if (!site.forms.includes(form)) showError($(`form-${form}`), HUMAN["form is off for this site"]);
    if (form === "booking") renderSlots();
  }).catch((err) => showError($(`form-${form}`), HUMAN[err.message] || err.message));
}
post({ type: "li:ready" });
