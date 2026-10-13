// EditStatic local server: serves a site folder with the editor switched on and
// writes saves straight back into the files. This is the engine the desktop app
// wraps. Listens on 127.0.0.1 only.
//
//   node apps/local/server.js <site-folder> [--port 8450] [--commit] [--push] [--sync <module>] [--build "<command>"]
//
// --commit  commit each save (the page plus any uploaded images) to the site's git repo
// --push    also push after each commit, so a host that deploys from the repo publishes it
// --sync    for sites built by a generator: a module (path relative to the site folder) whose
//           default export receives each text edit as { before, after } HTML and writes it into
//           the generator's source files. It returns one { ok, file } or { ok: false, error } per
//           change; refused changes are not saved, so the next build can't silently undo them.
// --build   a command run in the site folder after a synced save (e.g. "node build.js"), so the
//           built page matches the sources again. With --commit, every file the save and build
//           changed is committed together.
import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { annotate, applyEdits, hashText, findRegions, sanitizeInline } from '@editstatic/core';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);

const port = Number(args[args.indexOf('--port') + 1]) || 8450;
const COMMIT = args.includes('--commit') || args.includes('--push');
const PUSH = args.includes('--push');
const opt = name => (args.indexOf(name) > -1 ? args[args.indexOf(name) + 1] : null);
const SYNC = opt('--sync');
const BUILD = opt('--build');
const siteArgs = args.filter((a, i) => !a.startsWith('--') && !['--port', '--sync', '--build'].includes(args[i - 1]));
const siteArg = siteArgs[0];
if (!siteArg) { console.error('Usage: node apps/local/server.js <site-folder> [--port 8450] [--commit] [--push]'); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(process.cwd(), siteArg);
const EDITOR_JS = path.resolve(HERE, '../../packages/editor/editor.js');
const UPLOAD_DIR = 'images/uploads';
const MAX_UPLOAD = 15 * 1024 * 1024;
const IGNORE = new Set(['node_modules', '.git', '.github', '.sitecms', '.editstatic', '_source', '_planning']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

// ---------- paths ----------
// Maps a URL path to a file inside SITE, or null if it would escape the folder.
function resolveInSite(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  const full = path.resolve(SITE, '.' + path.posix.normalize('/' + rel));
  return full === SITE || full.startsWith(SITE + path.sep) ? full : null;
}

async function findPageFile(urlPath) {
  const full = resolveInSite(urlPath);
  if (!full) return null;
  const candidates = urlPath.endsWith('/') ? [path.join(full, 'index.html')] : [full, full + '.html', path.join(full, 'index.html')];
  for (const c of candidates) {
    const stat = await fs.stat(c).catch(() => null);
    if (stat?.isFile()) return c;
  }
  return null;
}

const toUrlPath = file => {
  const rel = path.relative(SITE, file).split(path.sep).join('/');
  return '/' + rel.replace(/(^|\/)index\.html$/, '$1');
};

async function listPages(dir = SITE, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listPages(full, out);
    else if (entry.name.endsWith('.html') && entry.name !== '404.html') {
      const html = await fs.readFile(full, 'utf8');
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
      out.push({ path: toUrlPath(full), title });
    }
  }
  return out.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
}

// ---------- responses ----------
const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
};
const json = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json');

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const scriptJson = data => JSON.stringify(data).replace(/</g, '\\u003c');

async function servePage(res, file, urlPath) {
  const source = await fs.readFile(file, 'utf8');
  const config = { api: '/__es/api', page: toUrlPath(file), version: await hashText(source) };
  const inject = `<script id="editstatic-config" type="application/json">${scriptJson(config)}</script>`
    + `<script src="/__es/editor.js" defer></script>`;
  send(res, 200, annotate(source, { inject }).html, MIME['.html']);
}

// ---------- git ----------
const git = (...gitArgs) => new Promise((resolve, reject) => {
  execFile('git', gitArgs, { cwd: SITE, windowsHide: true }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim()));
});

// Images uploaded since the last commit; they go into the next save's commit.
const pendingUploads = new Set();

async function commitSave(file, count) {
  const rel = path.relative(SITE, file).split(path.sep).join('/');
  const uploads = [...pendingUploads];
  await git('add', '--', rel, ...uploads);
  // Committing by path leaves anything else the owner has staged alone.
  await git('commit', '-m', `Edit ${rel} (${count} change${count === 1 ? '' : 's'}) with EditStatic`, '--', rel, ...uploads);
  uploads.forEach(u => pendingUploads.delete(u));
  console.log(`committed ${rel}`);
  if (PUSH) {
    // Pushing can take a few seconds; the editor doesn't wait for it.
    git('push').then(() => console.log('pushed')).catch(err => console.error('push failed:', err.message));
  }
}

// ---------- generated sites: sync to source, rebuild, commit what changed ----------
let syncFn = null;
async function loadSync() {
  if (!syncFn) syncFn = (await import(pathToFileURL(path.resolve(SITE, SYNC)).href)).default;
  return syncFn;
}
const run = cmd => new Promise((resolve, reject) => {
  execFile(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
    { cwd: SITE, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim().slice(-800))) : resolve(stdout));
});
// dirty files and a fingerprint of each, so a commit can take exactly what this save changed
async function dirtyState() {
  const out = await git('status', '--porcelain', '-uall');
  const state = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const rel = line.slice(3).replace(/^"|"$/g, '');
    // contents, not timestamps: a rebuild rewrites files without changing them
    const data = await fs.readFile(path.join(SITE, rel)).catch(() => null);
    state.set(rel, data ? createHash('sha1').update(data).digest('hex') : 'gone');
  }
  return state;
}
// Commits what this save changed. Files the owner already had uncommitted changes in are left out
// (the build may rewrite them too), except the edited page and the sources the edit went into.
async function commitChanged(before, label, must = []) {
  const after = await dirtyState();
  const files = [...after.keys()].filter(f => before.get(f) !== after.get(f) && (!before.has(f) || must.includes(f)));
  if (!files.length) return false;
  await git('add', '--', ...files);
  await git('commit', '-m', label, '--', ...files);
  console.log(`committed ${files.length} file(s)`);
  if (PUSH) git('push').then(() => console.log('pushed')).catch(err => console.error('push failed:', err.message));
  return true;
}

async function syncedSave(res, file, source, body) {
  const { regions } = findRegions(source);
  const changes = [], errors = [];
  for (const edit of body.edits) {
    const r = regions[edit.id];
    if (!r) { errors.push({ id: edit.id, error: 'No such region' }); continue; }
    if (r.kind !== 'text' || typeof edit.html !== 'string') { errors.push({ id: edit.id, error: 'Images can\'t be edited on this site yet' }); continue; }
    changes.push({ id: edit.id, before: source.slice(r.innerStart, r.innerEnd), after: sanitizeInline(edit.html) });
  }
  const before = COMMIT ? await dirtyState() : null;
  const sync = await loadSync();
  const results = changes.length ? await sync({ root: SITE, page: toUrlPath(file), file, changes: changes.map(({ before, after }) => ({ before, after })) }) : [];
  const ok = changes.filter((c, i) => results[i]?.ok);
  changes.forEach((c, i) => { if (!results[i]?.ok) errors.push({ id: c.id, error: results[i]?.error || 'Could not find this text in the source files' }); });
  let html = source;
  if (ok.length) {
    html = applyEdits(source, ok.map(c => ({ id: c.id, html: c.after }))).html;
    await fs.writeFile(file, html, 'utf8');
    if (BUILD) { await run(BUILD); html = await fs.readFile(file, 'utf8').catch(() => html); }
  }
  const synced = ok.map((c, i) => results[changes.indexOf(c)].file);
  console.log(`saved ${path.relative(SITE, file)}: ${ok.length} edit(s) -> ${[...new Set(synced)].join(', ') || 'nothing'}${errors.length ? `, ${errors.length} refused` : ''}`);
  let committed = false;
  if (COMMIT && ok.length) {
    const must = [path.relative(SITE, file), ...synced].map(f => f.split(path.sep).join('/'));
    try { committed = await commitChanged(before, `Edit ${toUrlPath(file)} (${ok.length} change${ok.length === 1 ? '' : 's'}) with EditStatic`, must); }
    catch (err) { console.error('commit failed:', err.message); }
  }
  return json(res, 200, { ok: true, applied: ok.map(c => c.id), errors, committed, version: await hashText(html) });
}

// ---------- API ----------
// Writes only come from the editor's own page: same Host, same Origin, and a
// custom header a cross-site form or image tag can't send.
function trusted(req) {
  const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  const origin = req.headers.origin;
  const originOk = !origin || origin === `http://${req.headers.host}`;
  return hostOk && originOk && req.headers['x-editstatic'] === '1';
}

async function handleApi(req, res, route, query) {
  if (!trusted(req)) return json(res, 403, { error: 'Forbidden' });

  if (route === 'pages' && req.method === 'GET') return json(res, 200, { pages: await listPages() });

  if (route === 'save' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 2 * 1024 * 1024));
    const file = await findPageFile(String(body.page || ''));
    if (!file || !file.endsWith('.html')) return json(res, 404, { error: 'Page not found' });
    const source = await fs.readFile(file, 'utf8');
    if (body.version !== await hashText(source)) return json(res, 409, { error: 'Page changed since it was opened' });
    if (!Array.isArray(body.edits)) return json(res, 400, { error: 'No edits' });
    if (SYNC) return await syncedSave(res, file, source, body);
    const result = applyEdits(source, body.edits);
    if (result.applied.length) await fs.writeFile(file, result.html, 'utf8');
    console.log(`saved ${path.relative(SITE, file)}: ${result.applied.length} edit(s)${result.errors.length ? `, ${result.errors.length} refused` : ''}`);
    let committed = false;
    if (COMMIT && result.applied.length && result.html !== source) {
      // The file is saved either way; a git problem is reported, not fatal.
      try { await commitSave(file, result.applied.length); committed = true; }
      catch (err) { console.error('commit failed:', err.message); }
    }
    return json(res, 200, { ok: true, applied: result.applied, errors: result.errors, committed, version: await hashText(result.html) });
  }

  if (route === 'upload' && req.method === 'POST') {
    const data = await readBody(req, MAX_UPLOAD);
    const ext = path.extname(query.get('name') || '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return json(res, 400, { error: 'Images only (jpg, png, webp, gif)' });
    const base = path.basename(query.get('name'), path.extname(query.get('name')))
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'image';
    const name = `${base}-${createHash('sha256').update(data).digest('hex').slice(0, 6)}${ext}`;
    await fs.mkdir(path.join(SITE, UPLOAD_DIR), { recursive: true });
    await fs.writeFile(path.join(SITE, UPLOAD_DIR, name), data);
    pendingUploads.add(`${UPLOAD_DIR}/${name}`);
    return json(res, 200, { url: `/${UPLOAD_DIR}/${name}` });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/__es/editor.js') return send(res, 200, await fs.readFile(EDITOR_JS), MIME['.js']);
    if (url.pathname.startsWith('/__es/api/')) return await handleApi(req, res, url.pathname.slice(10), url.searchParams);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    const page = await findPageFile(url.pathname);
    if (page?.endsWith('.html')) {
      if (!url.pathname.endsWith('/') && page.endsWith('index.html') && !url.pathname.endsWith('.html')) {
        res.writeHead(301, { Location: url.pathname + '/' + url.search }); return res.end();
      }
      return await servePage(res, page, url.pathname);
    }
    if (page) return send(res, 200, await fs.readFile(page), MIME[path.extname(page).toLowerCase()] || 'application/octet-stream');

    const notFound = path.join(SITE, '404.html');
    const exists = await fs.stat(notFound).catch(() => null);
    return send(res, 404, exists ? await fs.readFile(notFound) : 'Not found', exists ? MIME['.html'] : undefined);
  } catch (err) {
    console.error(err);
    json(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`EditStatic editing ${SITE}${PUSH ? ' (commit + push on save)' : COMMIT ? ' (commit on save)' : ''}${SYNC ? `, syncing to source with ${SYNC}${BUILD ? ` and rebuilding with "${BUILD}"` : ''}` : ''}`);
  console.log(`Open http://127.0.0.1:${port}/`);
});
