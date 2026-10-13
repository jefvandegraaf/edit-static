// EditStatic web: the small server piece that sits in front of a site's editing deployment.
// Host-agnostic: cloudflare.js and netlify.js wrap it. It does nothing unless these are set
// (on the staging/branch-deploy environment only, so the live site never gets an editor):
//   EDIT_PASSWORD   the password that unlocks editing
//   GITHUB_TOKEN    fine-grained token with Contents: read and write on the site's repo
//   GITHUB_REPO     owner/name, e.g. jefvandegraaf/my-site
//   GITHUB_BRANCH   the branch this deployment is built from, e.g. staging
//   EDIT_HOST       optional: only this host gets the editor (e.g. staging--my-site.netlify.app)
//   EDIT_MODE       optional: auto (default), static (plain HTML pages) or dom (React and other JS apps)
// No page is parsed here (that runs in the browser, see client.js). A save is written to
// <branch>:.editstatic/pending/<id>.json; the site's GitHub Action (`editstatic apply`) writes it
// into the source files and records the outcome in .editstatic/results/<id>.json.

const COOKIE = 'es_auth';
const RAW = 'x-editstatic-raw';
const NAMES = ['EDIT_PASSWORD', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH', 'EDIT_HOST', 'EDIT_MODE'];
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
async function sha256(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))).slice(0, 16); }

/**
 * @param {object} o
 * @param {string} o.client   the browser loader (dist build inlines it)
 * @param {string} o.editor   the in-page editor
 * @param {(msg: string) => string} o.message  commit message for a queued save; lets a host skip the build it would trigger
 * @param {typeof fetch} [o.fetch]  GitHub API fetch (tests pass a fake)
 */
export function createHandler({ client = '', editor = '', message = (m) => m, fetch: gfetch = (...a) => fetch(...a) } = {}) {
  const gh = (env, method, path, body) => gfetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'EditStatic', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  async function api(req, url, env, asset) {
    const route = url.pathname.slice('/__es/api/'.length);
    if (route === 'login' && req.method === 'POST') {
      if (!trusted(req, url)) return json({ error: 'Forbidden' }, 403);
      const { password } = await req.json().catch(() => ({}));
      if (typeof password !== 'string' || !same(password, env.EDIT_PASSWORD)) {
        await new Promise((r) => setTimeout(r, 800)); // slows down guessing
        return json({ error: 'Wrong password' }, 401);
      }
      return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=${await token(env)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict` });
    }
    if (!(await authed(req, env))) return json({ error: 'Log in first: add ?edit to the address' }, 401);
    if (route === 'logout' && req.method === 'POST' && trusted(req, url)) return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
    if (route === 'pages' && req.method === 'GET') {
      // the page menu: every URL in the site's sitemaps (sitemap.xml, or a sitemap index and its files)
      const locs = async (p) => {
        const r = await asset(p).catch(() => null);
        if (!r || !r.ok || !/xml/.test(r.headers.get('content-type') || '')) return [];
        return [...(await r.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      };
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
      if (!r.ok) return json({ done: false });
      return json(JSON.parse(unb64((await r.json()).content)));
    }
    if (route === 'save' && req.method === 'POST') {
      if (!trusted(req, url)) return json({ error: 'Forbidden' }, 403);
      const body = await req.json().catch(() => null);
      if (!body || typeof body.page !== 'string' || !Array.isArray(body.changes)) return json({ error: 'Nothing to save' }, 400);
      const page = new URL(body.page, url.origin).pathname;
      // static pages: refuse if the page was redeployed since it was opened (another save landed first).
      // JS apps re-render per request, so their HTML is no version; the text match itself guards them.
      if (body.mode === 'static') {
        const live = await asset(page);
        if (!live.ok || body.version !== (await sha256(await live.text()))) return json({ error: 'This page was changed. Reload to get the latest.' }, 409);
      }
      const errors = body.changes.filter((c) => c.error).map((c) => ({ id: c.id, error: c.error }));
      const changes = body.changes.filter((c) => !c.error && typeof c.before === 'string' && typeof c.after === 'string')
        .slice(0, 200).map(({ before, after }) => ({ before: before.slice(0, 20000), after: after.slice(0, 20000) }));
      if (!changes.length) return json({ ok: true, applied: [], errors });
      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const r = await gh(env, 'PUT', `.editstatic/pending/${id}.json`, {
        message: message(`EditStatic: ${changes.length} edit${changes.length === 1 ? '' : 's'} on ${page}`),
        content: b64(JSON.stringify({ id, page, changes, at: new Date().toISOString() }, null, 2)),
        branch: env.GITHUB_BRANCH,
      });
      if (!r.ok) return json({ error: `Couldn't save to GitHub (${r.status}). Check the token and GITHUB_REPO/GITHUB_BRANCH.` }, 502);
      return json({ ok: true, pending: true, id, applied: body.changes.filter((c) => !c.error).map((c) => c.id), errors });
    }
    return json({ error: 'Not found' }, 404);
  }

  /**
   * @param {Request} req
   * @param {object} h
   * @param {object} h.env                 the settings above
   * @param {() => Promise<Response>} h.next       the site's own response for this request
   * @param {(path: string, origin: string) => Promise<Response>} h.fetchAsset  another path of the site, without the editor
   */
  return async function handle(req, { env, next, fetchAsset }) {
    const url = new URL(req.url);
    if (req.headers.get(RAW)) return next();
    // setup check: which settings this deployment can see (names only, never values)
    if (url.pathname === '/__es/api/health') {
      const missing = NAMES.slice(0, 4).filter((k) => !env[k]);
      return json({ editstatic: true, ready: !missing.length && (!env.EDIT_HOST || url.host === env.EDIT_HOST), missing, host: url.host, editHost: env.EDIT_HOST || null });
    }
    if (!env.EDIT_PASSWORD || !env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.GITHUB_BRANCH) return next();
    if (env.EDIT_HOST && url.host !== env.EDIT_HOST) return next();
    const asset = (p) => fetchAsset(p, url.origin);
    if (url.pathname === '/__es/web' || url.pathname === '/__es/editor') {
      return new Response(url.pathname === '/__es/web' ? client : editor, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }
    if (url.pathname.startsWith('/__es/api/')) return api(req, url, env, asset);
    const res = await next();
    if (req.method !== 'GET' || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
    const isAuthed = await authed(req, env);
    if (!isAuthed && !url.searchParams.has('edit')) return res;
    const mode = /^(static|dom)$/.test(env.EDIT_MODE || '') ? env.EDIT_MODE : 'auto';
    const tag = `<script src="/__es/web" data-authed="${isAuthed ? 1 : 0}" data-mode="${mode}" defer></script>`;
    const html = await res.text();
    const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
    const h = new Headers(res.headers);
    for (const k of ['content-length', 'content-encoding', 'etag', 'last-modified']) h.delete(k);
    h.set('Cache-Control', 'no-store');
    return new Response(at > -1 ? html.slice(0, at) + tag + html.slice(at) : html + tag, { status: res.status, headers: h });
  };
}
