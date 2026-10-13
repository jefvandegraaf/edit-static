// EditStatic web loader. The host injects this on pages of the editing deployment only
// (see middleware.js). Logged out + ?edit in the address: a password prompt. Logged in: it
// fetches the page's raw HTML, tags the editable regions in the browser (@editstatic/core, so the
// server never parses pages), re-renders the page with the editor, and on save sends each edit's
// before/after HTML so the site's build can write it into its sources.
import { annotate, findRegions, hashText, sanitizeInline } from '../../packages/core/src/index.js';

(() => {
  if (window.__editstaticWeb) return;
  window.__editstaticWeb = true;
  const me = document.currentScript;
  const authed = me && me.dataset.authed === '1';
  const API = '/__es/api';

  function login() {
    const box = document.createElement('div');
    box.innerHTML = `<form style="position:fixed;inset:auto 16px 16px auto;z-index:2147483647;display:flex;gap:8px;align-items:center;padding:12px;border-radius:14px;background:#101010;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.3)">
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

  async function edit() {
    // the raw page, without this loader (the host skips injection for X-EditStatic-Raw)
    const res = await fetch(location.pathname, { cache: 'no-store', headers: { 'X-EditStatic-Raw': '1' } });
    if (!res.ok) return;
    const source = await res.text();
    const version = await hashText(source);
    const { regions } = findRegions(source);
    const page = location.pathname.replace(/index\.html$/, '');
    const cfg = { api: API, page, version, mode: 'web' };
    // each saved edit goes up as { before, after }: the region's old inner HTML and the new one
    window.editstaticPrepare = (edits) => ({
      changes: edits.map((e) => {
        const r = regions[e.id];
        if (!r || r.kind !== 'text' || typeof e.html !== 'string') return { id: e.id, error: 'Images can\'t be edited here yet' };
        return { id: e.id, before: source.slice(r.innerStart, r.innerEnd), after: sanitizeInline(e.html) };
      }),
    });
    const inject = `<script id="editstatic-config" type="application/json">${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script>`
      + `<script src="/assets/editstatic/editor.js" defer></script>`;
    const prepare = window.editstaticPrepare;
    const html = annotate(source, { inject }).html;
    document.open();
    document.write(html);
    document.close();
    window.editstaticPrepare = prepare;
    window.__editstaticWeb = true;
  }

  const start = () => (authed ? edit() : new URLSearchParams(location.search).has('edit') && login());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
