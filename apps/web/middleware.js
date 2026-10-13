// EditStatic web: Cloudflare Pages Functions middleware for the editing deployment of a static site.
// Bundle it to the site's functions/_middleware.js. It does nothing unless these are set (put them
// on the Preview environment only, so the live site never gets an editor):
//   EDIT_PASSWORD   the password that unlocks editing
//   GITHUB_TOKEN    fine-grained token with Contents: read and write on the site's repo
//   GITHUB_REPO     owner/name, e.g. jefvandegraaf/jefvandegraaf-com
//   GITHUB_BRANCH   the branch this deployment is built from, e.g. staging
//   EDIT_HOST       optional: only this host gets the editor (e.g. staging.example.pages.dev)
// No page is parsed here (that runs in the browser, see client.js), so it stays far inside the
// Workers CPU limit. A save is written to <branch>:.editstatic/pending/<id>.json; the site's own
// build step (a GitHub Action) applies it to the sources, rebuilds, and writes .editstatic/results/<id>.json.

const COOKIE = 'es_auth';
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function token(env) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.EDIT_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode('editstatic-v1:' + env.GITHUB_REPO)));
}
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
// same-length compare so the check doesn't leak how much of the value matched
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function authed(req, env) { const c = cookie(req, COOKIE); return !!c && same(c, await token(env)); }
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
// writes come from the editing pages themselves: same origin plus a header a form or image can't send
function trusted(req, url) {
  const origin = req.headers.get('origin');
  return req.headers.get('x-editstatic') === '1' && (!origin || origin === url.origin);
}
const b64 = (s) => { let bin = ''; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function gh(env, method, path, body) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'EditStatic', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function sha256(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))).slice(0, 16); }

async function api(ctx, url) {
  const { request: req, env } = ctx;
  const route = url.pathname.slice('/__es/api/'.length);
  if (route === 'login' && req.method === 'POST') {
    if (!trusted(req, url)) return json({ error: 'Forbidden' }, 403);
    const { password } = await req.json().catch(() => ({}));
    if (typeof password !== 'string' || !same(password, env.EDIT_PASSWORD)) return json({ error: 'Wrong password' }, 401);
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=${await token(env)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict` });
  }
  if (route === 'logout' && req.method === 'POST') {
    if (!trusted(req, url)) return json({ error: 'Forbidden' }, 403);
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!(await authed(req, env))) return json({ error: 'Log in first: add ?edit to the address' }, 401);
  if (route === 'pages' && req.method === 'GET') {
    // the page menu: every URL in the site's sitemaps (sitemap.xml, or a sitemap index and its files)
    const locs = async (p) => { const r = await env.ASSETS.fetch(new URL(p, url.origin)); return r.ok ? [...(await r.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]) : []; };
    let urls = [];
    for (const top of ['/sitemap_index.xml', '/sitemap.xml']) {
      const found = await locs(top);
      if (!found.length) continue;
      const subs = found.filter((u) => /\.xml$/.test(u));
      urls = subs.length ? (await Promise.all(subs.map((u) => locs(new URL(u).pathname)))).flat() : found;
      break;
    }
    const title = (p) => p === '/' ? 'Home' : decodeURIComponent(p.replace(/\/$/, '').split('/').pop()).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const pages = [...new Set(urls.map((u) => { try { return new URL(u).pathname; } catch { return null; } }).filter(Boolean))]
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .map((p) => ({ path: p, title: title(p) }));
    return json({ pages });
  }
  if (route === 'status' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').replace(/[^\w-]/g, '');
    const r = await gh(env, 'GET', `.editstatic/results/${id}.json?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
    if (r.status === 404) return json({ done: false });
    if (!r.ok) return json({ done: false });
    return json(JSON.parse(unb64((await r.json()).content)));
  }
  if (route === 'save' && req.method === 'POST') {
    if (!trusted(req, url)) return json({ error: 'Forbidden' }, 403);
    const body = await req.json().catch(() => null);
    if (!body || typeof body.page !== 'string' || !Array.isArray(body.changes)) return json({ error: 'Nothing to save' }, 400);
    const page = new URL(body.page, url.origin).pathname;
    // refuse if the page was redeployed since it was opened (another save landed first)
    const live = await env.ASSETS.fetch(new URL(page, url.origin));
    if (!live.ok || body.version !== (await sha256(await live.text()))) return json({ error: 'This page was changed. Reload to get the latest.' }, 409);
    const errors = body.changes.filter((c) => c.error).map((c) => ({ id: c.id, error: c.error }));
    const changes = body.changes.filter((c) => !c.error && typeof c.before === 'string' && typeof c.after === 'string').map(({ before, after }) => ({ before, after }));
    if (!changes.length) return json({ ok: true, applied: [], errors });
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const r = await gh(env, 'PUT', `.editstatic/pending/${id}.json`, {
      message: `EditStatic: ${changes.length} edit${changes.length === 1 ? '' : 's'} on ${page}`,
      content: b64(JSON.stringify({ id, page, changes, at: new Date().toISOString() }, null, 2)),
      branch: env.GITHUB_BRANCH,
    });
    if (!r.ok) return json({ error: `Couldn't save to GitHub (${r.status}). Check the token.` }, 502);
    return json({ ok: true, pending: true, id, applied: body.changes.filter((c) => !c.error).map((c) => c.id), errors });
  }
  return json({ error: 'Not found' }, 404);
}

export async function onRequest(ctx) {
  const { request: req, env, next } = ctx;
  const url = new URL(req.url);
  // setup check: which settings this deployment can see (names only, never values)
  if (url.pathname === '/__es/api/health') {
    const missing = ['EDIT_PASSWORD', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'].filter((k) => !env[k]);
    return json({ editstatic: true, ready: !missing.length && (!env.EDIT_HOST || url.host === env.EDIT_HOST), missing, host: url.host, editHost: env.EDIT_HOST || null });
  }
  if (!env.EDIT_PASSWORD || !env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.GITHUB_BRANCH) return next();
  if (env.EDIT_HOST && url.host !== env.EDIT_HOST) return next();
  if (url.pathname.startsWith('/__es/api/')) return api(ctx, url);
  const res = await next();
  if (req.method !== 'GET' || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html') || req.headers.get('x-editstatic-raw')) return res;
  const isAuthed = await authed(req, env);
  if (!isAuthed && !url.searchParams.has('edit')) return res;
  // only a script tag is added (HTMLRewriter streams, no parsing cost); the browser does the rest
  const out = new HTMLRewriter().on('body', {
    element(el) { el.append(`<script src="/assets/editstatic/web.js" data-authed="${isAuthed ? 1 : 0}" defer></script>`, { html: true }); },
  }).transform(res);
  const h = new Headers(out.headers);
  h.set('Cache-Control', 'no-store');
  return new Response(out.body, { status: out.status, headers: h });
}
