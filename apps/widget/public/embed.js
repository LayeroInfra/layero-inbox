/* Layero Inbox — формы для сайта: проблема, заявка, запись.
 * <script src="https://<виджет>/embed.js" data-site="st_…" async></script>
 *
 *   data-form      какую форму открывает плавающая кнопка: problem (по умолчанию), lead, booking
 *   data-label     текст кнопки
 *   data-position  right (по умолчанию) или left
 *   data-button    off — без плавающей кнопки, только свои кнопки на странице
 * Своя кнопка в любом месте страницы: <button data-inbox="booking">Записаться</button>
 *
 * Этот файл работает на странице клиента и в Data API не ходит: CORS базы
 * пускает только наши домены. Он рисует кнопку, снимает экран (для проблемы)
 * и открывает iframe с нашего домена; данные уходят оттуда.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__layeroInbox) return;
  window.__layeroInbox = true;

  var FORMS = { problem: "Сообщить о проблеме", lead: "Оставить заявку", booking: "Записаться" };
  var siteKey = script.getAttribute("data-site");
  var mainForm = FORMS[script.getAttribute("data-form")] ? script.getAttribute("data-form") : "problem";
  var label = script.getAttribute("data-label") || FORMS[mainForm];
  var position = script.getAttribute("data-position") === "left" ? "left" : "right";
  var showButton = script.getAttribute("data-button") !== "off";
  var base = new URL(".", script.src).href;
  var origin = new URL(script.src).origin;
  if (!siteKey) {
    console.warn("[Layero Inbox] у тега <script> нет data-site — формы не включены");
    return;
  }

  var css =
    ".li-btn{position:fixed;bottom:20px;" + position + ":20px;z-index:2147483000;" +
    "font:600 15px/1 Geist,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#faf9f6;letter-spacing:-.01em;" +
    "background:#141413;border:0;border-radius:999px;padding:14px 20px 14px 16px;cursor:pointer;" +
    "box-shadow:0 10px 30px rgba(20,20,19,.22);display:flex;gap:10px;align-items:center}" +
    ".li-btn:hover{background:#000}.li-btn:focus-visible{outline:3px solid #ffc52e;outline-offset:3px}" +
    ".li-dot{width:10px;height:10px;border-radius:50%;background:#ffc52e;flex:none}" +
    ".li-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(20,20,19,.4);" +
    "display:flex;align-items:flex-end;justify-content:" + (position === "left" ? "flex-start" : "flex-end") + ";padding:16px}" +
    ".li-frame{width:400px;max-width:100%;height:640px;max-height:calc(100vh - 32px);border:0;" +
    "border-radius:20px;background:#faf9f6;box-shadow:0 24px 60px rgba(20,20,19,.3)}" +
    "@media (max-width:480px){.li-overlay{padding:0}.li-frame{width:100%;height:100%;max-height:none;border-radius:0}}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var btn = null;
  if (showButton) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "li-btn";
    btn.setAttribute("data-layero-inbox", "button");
    btn.innerHTML = '<span class="li-dot" aria-hidden="true"></span><span></span>';
    btn.lastChild.textContent = label;
    document.body.appendChild(btn);
    btn.addEventListener("click", function () { open(mainForm); });
  }

  // Свои кнопки на странице: data-inbox="lead" и т. п.
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-inbox]");
    if (!el) return;
    var form = el.getAttribute("data-inbox");
    if (!FORMS[form]) return;
    e.preventDefault();
    open(form);
  });

  function loadCapture() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = base + "vendor/html2canvas-pro.min.js";
      s.onload = function () { resolve(window.html2canvas); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Снимок видимой части страницы, JPEG не шире 1600 px.
  function capture() {
    return loadCapture().then(function (h2c) {
      var scale = Math.min(window.devicePixelRatio || 1, 1600 / window.innerWidth);
      return h2c(document.documentElement, {
        scale: scale,
        x: window.scrollX, y: window.scrollY,
        width: window.innerWidth, height: window.innerHeight,
        useCORS: true, logging: false,
        ignoreElements: function (el) {
          return el.hasAttribute && (el.hasAttribute("data-layero-inbox") || el.hasAttribute("data-layero-footer"));
        }
      });
    }).then(function (canvas) {
      return canvas.toDataURL("image/jpeg", 0.72);
    }).catch(function (e) {
      console.warn("[Layero Inbox] снимок экрана не получился:", e);
      return null;
    });
  }

  var overlay = null;
  var opener = null;
  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    if (btn) btn.style.display = "";
    if (opener && opener.focus) opener.focus();
  }

  function open(form) {
    if (overlay) return;
    opener = document.activeElement;
    if (btn) btn.style.display = "none";
    var shot = form === "problem" ? capture() : Promise.resolve(null);
    shot.then(function (screenshot) {
      var context = {
        type: "li:init",
        form: form,
        screenshot: screenshot,
        page_url: location.href,
        viewport: window.innerWidth + "x" + window.innerHeight,
        user_agent: navigator.userAgent,
        language: navigator.language
      };
      overlay = document.createElement("div");
      overlay.className = "li-overlay";
      overlay.setAttribute("data-layero-inbox", "overlay");
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
      var frame = document.createElement("iframe");
      frame.className = "li-frame";
      frame.title = FORMS[form];
      frame.src = base + "frame.html?site=" + encodeURIComponent(siteKey) + "&form=" + form;
      overlay.appendChild(frame);
      document.body.appendChild(overlay);

      function onMessage(e) {
        if (e.origin !== origin || e.source !== frame.contentWindow) return;
        if (e.data && e.data.type === "li:ready") frame.contentWindow.postMessage(context, origin);
        if (e.data && e.data.type === "li:close") { window.removeEventListener("message", onMessage); close(); }
      }
      window.addEventListener("message", onMessage);
    });
  }

  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && overlay) close(); });
})();
