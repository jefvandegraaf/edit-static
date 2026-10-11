// EditStatic local server: serves a site folder with the editor switched on and
// writes saves straight back into the files. This is the engine the desktop app
// wraps. Listens on 127.0.0.1 only.
//
//   node apps/local/server.js <site-folder> [--port 8450]
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { annotate, applyEdits, hashText } from '@editstatic/core';

const args = process.argv.slice(2);
const siteArg = args.find(a => !a.startsWith('--'));
const port = Number(args[args.indexOf('--port') + 1]) || 8450;
if (!siteArg) { console.error('Usage: node apps/local/server.js <site-folder> [--port 8450]'); process.exit(1); }

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
    const result = applyEdits(source, body.edits);
    if (result.applied.length) await fs.writeFile(file, result.html, 'utf8');
    console.log(`saved ${path.relative(SITE, file)}: ${result.applied.length} edit(s)${result.errors.length ? `, ${result.errors.length} refused` : ''}`);
    return json(res, 200, { ok: true, applied: result.applied, errors: result.errors, version: await hashText(result.html) });
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
  console.log(`EditStatic editing ${SITE}`);
  console.log(`Open http://127.0.0.1:${port}/`);
});
