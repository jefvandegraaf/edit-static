// EditStatic in-page editor. Loaded into a site page that the server has tagged
// with data-es="<id>" on every editable region (see @editstatic/core annotate).
// Talks to the server through window config #editstatic-config:
//   { api, page, version, pages?: [{path, title}] }
// Same file runs in the local/desktop server and the live web app.
(() => {
  'use strict';
  const cfgEl = document.getElementById('editstatic-config');
  if (!cfgEl || window.__editstatic) return;
  window.__editstatic = true;
  const cfg = JSON.parse(cfgEl.textContent);

  const root = document.documentElement;
  const regions = [...document.querySelectorAll('[data-es]')];
  const texts = regions.filter(el => el.tagName !== 'IMG');
  const images = regions.filter(el => el.tagName === 'IMG');
  const original = new Map(); // el -> innerHTML, or {src, alt, srcset} for images
  const imageEdits = new Map(); // el -> {src?, alt?, width?, height?}
  let editing = true;
  let saving = false;

  // ---------- page styles (outlines live in the page, the bar lives in a shadow root) ----------
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `
    html.es-on [data-es] { cursor: text; transition: outline-color .12s; }
    html.es-on img[data-es] { cursor: pointer; }
    html.es-on [data-es]:hover { outline: 2px dashed #2563eb !important; outline-offset: 3px; }
    html.es-on [data-es]:focus { outline: 2px solid #2563eb !important; outline-offset: 3px; }
    /* Unsaved text turns red (no box); an unsaved image, which has no text, gets a red outline.
       Both stay visible in Preview, so Preview shows exactly what Save all will change. */
    [data-es].es-dirty:not(img), [data-es].es-dirty:not(img) * { color: #dc2626 !important; -webkit-text-fill-color: #dc2626 !important; }
    html.es-on [data-es].es-dirty:not(img):not(:focus):not(:hover) { outline: none !important; }
    img[data-es].es-dirty { outline: 2px solid #dc2626 !important; outline-offset: 3px; }
    html.es-on body { padding-bottom: 88px !important; }
  `;
  document.head.appendChild(pageStyle);

  // ---------- the bar ----------
  const host = document.createElement('editstatic-bar');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647;
        display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 16px;
        background: #fff; color: #111; border: 1px solid #d4d4d8; border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,.18); font: 500 14px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
        max-width: calc(100vw - 32px); box-sizing: border-box; }
      .brand { font-weight: 600; letter-spacing: -.01em; white-space: nowrap; }
      select { font: inherit; padding: 6px 8px; border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; color: #111; max-width: 180px; }
      .status { color: #52525b; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .status.dirty { color: #dc2626; }
      .status.error { color: #b91c1c; }
      button { font: inherit; border-radius: 8px; padding: 8px 14px; cursor: pointer; white-space: nowrap; }
      .ghost { background: #fff; color: #111; border: 1px solid #d4d4d8; }
      .save { background: #000; color: #fff; border: 1px solid #000; }
      button:disabled { opacity: .4; cursor: default; }
      .toggle { display: flex; border: 1px solid #d4d4d8; border-radius: 8px; overflow: hidden; }
      .toggle button { border: 0; border-radius: 0; padding: 7px 10px; background: #fff; color: #52525b; }
      .toggle button[aria-pressed="true"] { background: #f4f4f5; color: #111; }
      .pop { position: fixed; z-index: 2147483647; width: 280px; padding: 14px; background: #fff; color: #111;
        border: 1px solid #d4d4d8; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18);
        font: 400 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-sizing: border-box; }
      .pop[hidden] { display: none; }
      .pop label { display: block; font-weight: 500; margin: 10px 0 4px; }
      .pop input[type=text] { width: 100%; box-sizing: border-box; font: inherit; padding: 7px 9px; border: 1px solid #d4d4d8; border-radius: 8px; }
      .pop .row { display: flex; gap: 8px; margin-top: 12px; }
      .pop .row button { flex: 1; }
      .pop .hint { color: #71717a; font-size: 12px; margin-top: 4px; }
      @media (max-width: 640px) {
        .bar { left: 8px; right: 8px; bottom: 8px; transform: none; max-width: none; gap: 6px; padding: 6px; flex-wrap: wrap; }
        .brand { display: none; }
        .status { order: 1; flex: 1; padding-left: 6px; font-size: 13px; }
        .discard { order: 2; }
        .save { order: 3; }
        select { order: 4; flex: 1 1 60%; min-width: 0; max-width: none; }
        .toggle { order: 5; }
        button { padding: 8px 10px; }
      }
    </style>
    <div class="bar" role="toolbar" aria-label="EditStatic">
      <span class="brand">EditStatic</span>
      <select class="pages" aria-label="Page"></select>
      <div class="toggle" role="group" aria-label="Mode">
        <button type="button" class="mode-edit" aria-pressed="true">Edit</button>
        <button type="button" class="mode-preview" aria-pressed="false">Preview</button>
      </div>
      <span class="status" aria-live="polite">No changes</span>
      <button type="button" class="ghost discard" disabled>Discard</button>
      <button type="button" class="save" disabled>Save all</button>
    </div>
    <div class="pop" hidden role="dialog" aria-label="Image">
      <strong>Image</strong>
      <button type="button" class="ghost replace" style="width:100%;margin-top:10px">Replace image…</button>
      <input type="file" class="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
      <label for="es-alt">Description (alt text)</label>
      <input type="text" id="es-alt" class="alt" placeholder="What the image shows">
      <div class="hint">Read aloud by screen readers and used by Google.</div>
      <div class="row"><button type="button" class="ghost pop-close">Done</button></div>
    </div>`;
  document.body.appendChild(host);
  const $ = sel => shadow.querySelector(sel);
  const ui = {
    pages: $('.pages'), status: $('.status'), discard: $('.discard'), save: $('.save'),
    edit: $('.mode-edit'), preview: $('.mode-preview'),
    pop: $('.pop'), replace: $('.replace'), file: $('.file'), alt: $('.alt'), popClose: $('.pop-close'),
  };

  // ---------- state ----------
  const isDirty = el => el.tagName === 'IMG' ? imageEdits.has(el) : el.innerHTML !== original.get(el);
  const dirtyCount = () => regions.filter(isDirty).length;

  function refresh(message, tone) {
    const n = dirtyCount();
    for (const el of regions) el.classList.toggle('es-dirty', isDirty(el));
    ui.discard.disabled = !n || saving;
    ui.save.disabled = !n || saving;
    ui.status.className = 'status' + (tone ? ' ' + tone : n ? ' dirty' : '');
    ui.status.textContent = message || (n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'No changes');
  }

  function setEditing(on) {
    editing = on;
    root.classList.toggle('es-on', on);
    ui.edit.setAttribute('aria-pressed', String(on));
    ui.preview.setAttribute('aria-pressed', String(!on));
    for (const el of texts) {
      if (on) { el.setAttribute('contenteditable', 'true'); el.setAttribute('spellcheck', 'true'); }
      else { el.removeAttribute('contenteditable'); el.removeAttribute('spellcheck'); }
    }
    // Open every <details> (FAQ answers) so hidden text can be edited too. An
    // exclusive accordion (name="…") only allows one open, so its name is set
    // aside while editing. None of this is saved: only region contents are.
    for (const d of document.querySelectorAll('details')) {
      if (on) {
        if (!d.dataset.esWasOpen) d.dataset.esWasOpen = d.open ? '1' : '0';
        if (d.name) { d.dataset.esName = d.name; d.removeAttribute('name'); }
        d.open = true;
      } else if (d.dataset.esWasOpen) {
        d.open = d.dataset.esWasOpen === '1';
        if (d.dataset.esName) d.setAttribute('name', d.dataset.esName);
        delete d.dataset.esWasOpen; delete d.dataset.esName;
      }
    }
    if (!on) closePop();
  }

  for (const el of texts) original.set(el, el.innerHTML);
  for (const el of images) original.set(el, { src: el.getAttribute('src'), alt: el.getAttribute('alt'), srcset: el.getAttribute('srcset') });

  // ---------- text editing ----------
  // Enter puts a line break (<br>) where the caret is, so a heading breaks where
  // the author wants. Buttons, links and other one-line labels never break.
  const ONE_LINE = new Set(['A', 'BUTTON', 'LABEL', 'SUMMARY', 'SPAN', 'SMALL', 'STRONG', 'EM', 'B', 'I', 'TIME', 'CODE', 'ABBR', 'CITE', 'Q', 'SUB', 'SUP']);

  document.addEventListener('input', e => { if (e.target.closest?.('[data-es]')) refresh(); }, true);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    const el = e.target.closest?.('[data-es][contenteditable]');
    if (!el) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!ONE_LINE.has(el.tagName)) document.execCommand('insertLineBreak');
    }
    if (e.key === 'Escape') el.blur();
  }, true);

  // Pasted text arrives as plain text so another site's styles never land in the file.
  document.addEventListener('paste', e => {
    if (!e.target.closest?.('[data-es][contenteditable]')) return;
    e.preventDefault();
    const text = (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ');
    document.execCommand('insertText', false, text);
  }, true);

  document.addEventListener('drop', e => { if (editing && e.target.closest?.('[data-es]')) e.preventDefault(); }, true);

  // In edit mode links and buttons don't fire, so clicking "Call us" edits it.
  document.addEventListener('click', e => {
    if (!editing || e.composedPath().includes(host)) return;
    const img = e.target.closest?.('img[data-es]');
    if (img) { e.preventDefault(); e.stopPropagation(); openPop(img); return; }
    if (e.target.closest?.('a, button, input[type=submit], label, summary')) { e.preventDefault(); }
    if (!e.target.closest?.('[data-es]')) closePop();
  }, true);
  document.addEventListener('submit', e => { if (editing) e.preventDefault(); }, true);

  // ---------- images ----------
  let popImg = null;

  function openPop(img) {
    popImg = img;
    ui.alt.value = img.getAttribute('alt') || '';
    ui.pop.hidden = false;
    const r = img.getBoundingClientRect();
    const w = 280, h = ui.pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > innerHeight - 90) top = Math.max(8, r.top - h - 8);
    ui.pop.style.left = left + 'px';
    ui.pop.style.top = top + 'px';
  }
  function closePop() { ui.pop.hidden = true; popImg = null; }

  function noteImage(img, change) {
    const next = { ...(imageEdits.get(img) || {}), ...change };
    const o = original.get(img);
    if (next.alt === (o.alt ?? '') && !('src' in next)) delete next.alt;
    if (Object.keys(next).length) imageEdits.set(img, next); else imageEdits.delete(img);
    refresh();
  }

  ui.alt.addEventListener('input', () => {
    if (!popImg) return;
    popImg.setAttribute('alt', ui.alt.value);
    noteImage(popImg, { alt: ui.alt.value });
  });
  ui.popClose.addEventListener('click', closePop);
  ui.replace.addEventListener('click', () => ui.file.click());

  // Resizes to at most 2400px wide and re-encodes. Re-encoding through a canvas
  // also strips camera metadata, GPS location included.
  async function prepareImage(file) {
    if (file.type === 'image/gif') return { blob: file, name: file.name };
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / bmp.width);
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const png = file.type === 'image/png';
    const blob = await new Promise(res => canvas.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.85));
    const base = file.name.replace(/\.[^.]+$/, '');
    return { blob, name: `${base}.${png ? 'png' : 'jpg'}`, width: w, height: h };
  }

  ui.file.addEventListener('change', async () => {
    const file = ui.file.files[0];
    ui.file.value = '';
    const img = popImg;
    if (!file || !img) return;
    refresh('Uploading image…');
    try {
      const prepared = await prepareImage(file);
      const res = await api('upload?name=' + encodeURIComponent(prepared.name), {
        method: 'POST', body: prepared.blob, headers: { 'Content-Type': prepared.blob.type || 'application/octet-stream' },
      });
      img.removeAttribute('srcset');
      img.closest('picture')?.querySelectorAll('source').forEach(s => s.remove());
      img.setAttribute('src', res.url);
      const change = { src: res.url };
      if (prepared.width) Object.assign(change, { width: prepared.width, height: prepared.height });
      noteImage(img, change);
    } catch (err) {
      refresh(err.message, 'error');
    }
  });

  // ---------- server ----------
  async function api(path, opts = {}) {
    const res = await fetch(cfg.api + '/' + path, {
      ...opts, credentials: 'same-origin',
      headers: { 'X-EditStatic': '1', ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status, body });
    return body;
  }

  async function save() {
    if (saving || !dirtyCount()) return;
    saving = true;
    refresh('Saving…');
    const edits = [];
    for (const el of texts) if (isDirty(el)) edits.push({ id: Number(el.dataset.es), html: el.innerHTML });
    for (const [el, change] of imageEdits) edits.push({ id: Number(el.dataset.es), ...change });
    try {
      const res = await api('save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: cfg.page, version: cfg.version, edits }),
      });
      if (res.errors?.length) console.warn('EditStatic: some edits were not saved', res.errors);
      // Region ids come from the file, and an edit can change the file's regions
      // (an emptied paragraph stops being one), so reload from the saved file.
      try { sessionStorage.setItem('editstatic-scroll', JSON.stringify({ page: cfg.page, y: scrollY, saved: true })); } catch {}
      saving = false;
      for (const el of texts) original.set(el, el.innerHTML);
      imageEdits.clear();
      location.reload();
    } catch (err) {
      saving = false;
      refresh(err.status === 409 ? 'This page was changed elsewhere. Reload to get the latest.' : err.message, 'error');
    }
  }

  function discard() {
    for (const el of texts) if (isDirty(el)) el.innerHTML = original.get(el);
    for (const el of imageEdits.keys()) {
      const o = original.get(el);
      el.setAttribute('src', o.src);
      o.alt == null ? el.removeAttribute('alt') : el.setAttribute('alt', o.alt);
      if (o.srcset) el.setAttribute('srcset', o.srcset);
    }
    imageEdits.clear();
    closePop();
    refresh();
  }

  ui.save.addEventListener('click', save);
  ui.discard.addEventListener('click', discard);
  ui.edit.addEventListener('click', () => setEditing(true));
  ui.preview.addEventListener('click', () => setEditing(false));

  window.addEventListener('beforeunload', e => { if (dirtyCount() && !saving) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- pages ----------
  async function loadPages() {
    let pages = cfg.pages;
    if (!pages) { try { pages = (await api('pages')).pages; } catch { pages = []; } }
    if (!pages.some(p => p.path === cfg.page)) pages.unshift({ path: cfg.page, title: cfg.page });
    ui.pages.innerHTML = '';
    for (const p of pages) {
      const opt = new Option(p.title ? `${p.title} (${p.path})` : p.path, p.path, false, p.path === cfg.page);
      ui.pages.add(opt);
    }
  }
  ui.pages.addEventListener('change', () => {
    const target = ui.pages.value;
    if (dirtyCount() && !confirm('Leave this page? Your unsaved changes will be lost.')) { ui.pages.value = cfg.page; return; }
    imageEdits.clear();
    for (const el of texts) original.set(el, el.innerHTML);
    location.href = target;
  });

  // ---------- start ----------
  setEditing(true);
  loadPages();
  let message;
  try {
    const s = JSON.parse(sessionStorage.getItem('editstatic-scroll') || 'null');
    sessionStorage.removeItem('editstatic-scroll');
    if (s && s.page === cfg.page) { scrollTo(0, s.y); if (s.saved) message = 'Saved'; }
  } catch {}
  refresh(message);
  if (message) setTimeout(() => refresh(), 4000);
})();
