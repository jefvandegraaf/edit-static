// Runs the whole EditStatic web loop on your computer, for developing EditStatic itself:
// the built host bundle (dist/) in front of a site, a stand-in for GitHub that writes queued saves
// into the site folder, and `editstatic apply` + the site's build running right after each save.
//
//   node scripts/dev-web.mjs <site-repo> [--serve dist] [--build "npm run build"] [--host netlify|cloudflare] [--port 8788]
//
// Then open http://127.0.0.1:8788/?edit (password: dev). The site folder's files really change.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processQueue } from '../packages/sync/src/apply.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const repo = path.resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || '.');
const serve = path.resolve(repo, opt('--serve', '.'));
const buildCmd = opt('--build', null);
const host = opt('--host', 'cloudflare');
const port = Number(opt('--port', 8788));
const env = { EDIT_PASSWORD: 'dev', GITHUB_TOKEN: 'dev', GITHUB_REPO: 'local/site', GITHUB_BRANCH: 'staging' };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.xml': 'application/xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function staticResponse(url) {
  let p = decodeURIComponent(new URL(url).pathname);
  let file = path.join(serve, p);
  if (!file.startsWith(serve)) return new Response('Forbidden', { status: 403 });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && !path.extname(p) && fs.existsSync(file + '.html')) file += '.html';
  // SPA fallback, like a _redirects /* /index.html 200 rule
  if (!fs.existsSync(file) && !path.extname(p)) file = path.join(serve, 'index.html');
  if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
}

// stand-in for the GitHub contents API, backed by the site folder
let applying = Promise.resolve();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
  const rel = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
  const file = path.join(repo, rel);
  if (init.method === 'PUT') {
    const body = JSON.parse(init.body);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(body.content, 'base64'));
    console.log(`[github] ${body.message}`);
    // what the GitHub Action does, a moment later
    applying = applying.then(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const { applied } = await processQueue(repo, { log: (m) => console.log('[action] ' + m) });
      if (applied && buildCmd) { console.log(`[deploy] ${buildCmd}`); execSync(buildCmd, { cwd: repo, stdio: 'inherit' }); }
    }).catch((e) => console.error(e));
    return new Response('{}', { status: 201 });
  }
  if (!fs.existsSync(file)) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify({ content: fs.readFileSync(file).toString('base64') }), { headers: { 'content-type': 'application/json' } });
};

let handle;
if (host === 'netlify') {
  globalThis.Netlify = { env: { get: (k) => env[k] } };
  const mod = await import(pathToFileURL(path.join(ROOT, 'dist/netlify/editstatic.js')).href);
  handle = (req) => mod.default(req, { next: async () => staticResponse(req.url) });
} else {
  const mod = await import(pathToFileURL(path.join(ROOT, 'dist/cloudflare/_middleware.js')).href);
  handle = (req) => mod.onRequest({ request: req, env: { ...env, ASSETS: { fetch: async (u) => staticResponse(String(u.url || u)) } }, next: async () => staticResponse(req.url) });
}

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await handle(request);
    // Secure cookies don't stick on plain http://127.0.0.1 in every browser; drop the flag locally
    const headers = Object.fromEntries([...out.headers].map(([k, v]) => [k, k === 'set-cookie' ? v.replace('; Secure', '') : v]));
    res.writeHead(out.status, headers);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end('Server error');
  }
}).listen(port, '127.0.0.1', () => console.log(`EditStatic dev (${host}) for ${repo}\nOpen http://127.0.0.1:${port}/?edit  (password: dev)`));
