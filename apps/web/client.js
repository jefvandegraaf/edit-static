// EditStatic web loader. The host injects this on pages of the editing deployment only (see
// handler.js). Logged out + ?edit in the address: a password prompt. Logged in: it opens the editor
// in one of two ways:
//   static  plain HTML pages: fetch the page's raw HTML, tag the editable regions with exact source
//           offsets (@editstatic/core), re-render the page with the editor
//   dom     React and other JS apps (Lovable, Bolt, v0, Replit...): the HTML is an empty shell, so
//           wait for the app to render and tag the elements on the live page
// On save it sends each edit's before/after HTML; the site's GitHub Action writes it into the sources.
import { annotate, findRegions, hashText, sanitizeInline, INLINE } from '../../packages/core/src/index.js';

(() => {
  if (window.__editstaticWeb) return;
  window.__editstaticWeb = true;
  const me = document.currentScript;
  const authed = me && me.dataset.authed === '1';
  const wanted = (me && me.dataset.mode) || 'auto';
  const API = '/__es/api';

  function login() {
    const box = document.createElement('div');
    box.innerHTML = `<form style="position:fixed;inset:auto 16px 16px auto;z-index:2147483647;display:flex;flex-wrap:wrap;gap:8px;align-items:center;max-width:calc(100vw - 32px);box-sizing:border-box;padding:12px;border-radius:14px;background:#101010;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.3)">
      <label>Edit password <input type="password" required autocomplete="current-password" style="margin-left:6px;padding:8px 10px;border-radius:8px;border:0;font:inherit;background:#fff !important;color:#101010 !important;-webkit-text-fill-color:#101010 !important;caret-color:#101010"></label>
      <button style="padding:8px 14px;border-radius:8px;border:0;background:#ffdd00 !important;color:#101010 !important;font:inherit;font-weight:700;cursor:pointer">Edit</button>
      <output style="color:#ff8a8a"></output></form>`;
    const form = box.firstElementChild;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch(API + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EditStatic': '1' }, body: JSON.stringify({ password: form.querySelector('input').value }) });
      if (!res.ok) { form.querySelector('output').textContent = 'Wrong password'; return; }
      const u = new URL(location.href); u.searchParams.delete('edit'); location.replace(u.href);
    });
    document.body.appendChild(box);
    form.querySelector('input').focus();
  }

  const FRAMEWORK = /id=["'](root|app|__next|__nuxt|svelte)["']|__NEXT_DATA__|data-reactroot|ng-version|data-v-app|data-server-rendered|data-sveltekit|<astro-island|tanstack|__TSR/i;

  async function edit() {
    // the raw page, without this loader (the host skips injection for X-EditStatic-Raw)
    const res = await fetch(location.pathname, { cache: 'no-store', headers: { 'X-EditStatic-Raw': '1' } });
    const source = res.ok ? await res.text() : '';
    let mode = wanted;
    if (mode === 'auto') {
      // an app shell (<div id="root"></div>) has next to no text of its own
      mode = FRAMEWORK.test(source) || findRegions(source).regions.filter((r) => r.kind === 'text').length < 3 ? 'dom' : 'static';
    }
    if (mode === 'dom') return editLive();

    const version = await hashText(source);
    const { regions } = findRegions(source);
    const page = location.pathname.replace(/index\.html$/, '');
    const cfg = { api: API, page, version, mode: 'static' };
    // each saved edit goes up as { before, after }: the region's old inner HTML and the new one
    const prepare = (edits) => ({
      mode: 'static',
      changes: edits.map((e) => {
        const r = regions[e.id];
        if (!r || r.kind !== 'text' || typeof e.html !== 'string') return { id: e.id, error: 'Images can\'t be changed here yet' };
        return { id: e.id, before: source.slice(r.innerStart, r.innerEnd), after: sanitizeInline(e.html) };
      }),
    });
    const inject = `<script id="editstatic-config" type="application/json">${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script>`
      + '<script src="/__es/editor" defer></script>';
    const html = annotate(source, { inject }).html;
    // the page is about to be drawn again from scratch: stop the first copy's timers and animation
    // loops, or every animation on the page runs twice (and heavy pages crawl)
    const lastT = setTimeout(() => {}, 0);
    for (let i = 0; i <= lastT; i++) { clearTimeout(i); clearInterval(i); }
    const lastR = requestAnimationFrame(() => {});
    for (let i = 0; i <= lastR; i++) cancelAnimationFrame(i);
    document.open();
    document.write(html);
    document.close();
    window.editstaticPrepare = prepare;
    window.__editstaticWeb = true;
  }

  // ---------- JS apps: tag the rendered page ----------
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS', 'VIDEO', 'AUDIO', 'PRE', 'INPUT', 'EDITSTATIC-BAR', 'HEAD']);
  // inside a text region these are kept as they are (icons next to a label), never edited
  const ATOMIC = new Set(['svg', 'img', 'picture', 'video', 'canvas', 'input']);
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  const inlineOnly = (el) => [...el.children].every((c) => {
    const t = c.tagName.toLowerCase();
    if (ATOMIC.has(t)) return true;
    if (t === 'i' && !c.textContent.trim()) return true; // icon fonts
    return INLINE.has(t) && inlineOnly(c);
  });

  // resolves once the app has rendered and stopped changing the page (or after 5s)
  const settle = () => new Promise((resolve) => {
    let t;
    const done = () => { obs.disconnect(); clearTimeout(t); resolve(); };
    const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 500); });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    t = setTimeout(done, 700);
    setTimeout(done, 5000);
  });

  async function editLive() {
    await settle();
    const before = new Map();
    let n = 0;
    const visit = (el) => {
      if (SKIP.has(el.tagName) || el.getAttribute('data-edit') === 'off' || el.isContentEditable) return;
      if (el.hasAttribute('data-edit') || (hasOwnText(el) && inlineOnly(el))) {
        el.setAttribute('data-es', String(n));
        before.set(n, sanitizeInline(el.innerHTML));
        el.querySelectorAll('svg, img, picture, video, canvas, input, i').forEach((c) => { if (c.tagName !== 'I' || !c.textContent.trim()) c.setAttribute('contenteditable', 'false'); });
        n++;
        return;
      }
      for (const c of el.children) visit(c);
    };
    visit(document.body);

    window.editstaticPrepare = (edits) => ({
      mode: 'dom',
      changes: edits.map((e) => {
        if (typeof e.html !== 'string' || !before.has(e.id)) return { id: e.id, error: 'Images can\'t be changed here yet' };
        return { id: e.id, before: before.get(e.id), after: sanitizeInline(e.html) };
      }),
    });
    // a saved edit stays on screen; the next save of the same element starts from it
    window.editstaticSaved = (ids) => { for (const id of ids) { const el = document.querySelector(`[data-es="${id}"]`); if (el) before.set(id, sanitizeInline(el.innerHTML)); } };

    const cfg = document.createElement('script');
    cfg.id = 'editstatic-config';
    cfg.type = 'application/json';
    cfg.textContent = JSON.stringify({ api: API, page: location.pathname, mode: 'dom', lineBreaks: false });
    document.body.appendChild(cfg);
    const s = document.createElement('script');
    s.src = '/__es/editor';
    document.body.appendChild(s);

    // the app changing route (Preview mode lets links work) means a new page to tag: reload it
    let path = location.pathname;
    const check = () => { if (location.pathname !== path) { path = location.pathname; location.reload(); } };
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) { const r = orig.apply(this, args); setTimeout(check); return r; };
    }
    addEventListener('popstate', check);
  }

  const start = () => (authed ? edit() : new URLSearchParams(location.search).has('edit') && login());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
