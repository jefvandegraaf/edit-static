import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../handler.js';

const ENV = { EDIT_PASSWORD: 'correct horse', GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'me/site', GITHUB_BRANCH: 'staging', EDIT_HOST: 'staging.site.test' };
const PAGE = '<!doctype html><html><head><title>Hi</title></head><body><h1>Hello</h1><p>World</p><p>Third</p></body></html>';

function setup(env = ENV) {
  const calls = [];
  const files = new Map();
  const gh = async (url, opts) => {
    calls.push({ url, ...opts });
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
    if (opts.method === 'PUT') { files.set(path, JSON.parse(opts.body)); return new Response('{}', { status: 201 }); }
    const f = files.get(path);
    return f ? new Response(JSON.stringify({ content: f.content })) : new Response('{}', { status: 404 });
  };
  const handle = createHandler({ client: 'CLIENT', editor: 'EDITOR', message: (m) => `${m} [skip netlify]`, fetch: gh });
  const site = (path) => path === '/sitemap.xml'
    ? new Response('<urlset><url><loc>https://x.test/</loc></url><url><loc>https://x.test/about/</loc></url></urlset>', { headers: { 'content-type': 'application/xml' } })
    : new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(PAGE.length) } });
  const run = (path, init = {}, host = 'staging.site.test') => {
    const req = new Request(`https://${host}${path}`, init);
    return handle(req, { env, next: async () => site(new URL(req.url).pathname), fetchAsset: async (p) => site(p) });
  };
  return { run, calls, files };
}
const post = (body, extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EditStatic': '1', Origin: 'https://staging.site.test', ...extra.headers }, body: JSON.stringify(body) });
async function login(run) {
  const res = await run('/__es/api/login', post({ password: 'correct horse' }));
  return res.headers.get('set-cookie').split(';')[0];
}

test('does nothing without settings, on another host, or for a raw fetch', async () => {
  const off = setup({});
  assert.equal(await (await off.run('/?edit')).text(), PAGE);
  const { run } = setup();
  assert.equal(await (await run('/?edit', {}, 'www.site.test')).text(), PAGE);
  assert.equal(await (await run('/?edit', { headers: { 'x-editstatic-raw': '1' } })).text(), PAGE);
  assert.equal(await (await run('/')).text(), PAGE, 'not logged in and no ?edit: untouched');
});

test('health lists missing setting names, never values', async () => {
  const { run } = setup({ GITHUB_TOKEN: 'secret' });
  const body = await (await run('/__es/api/health')).json();
  assert.deepEqual(body.missing, ['EDIT_PASSWORD', 'GITHUB_REPO', 'GITHUB_BRANCH']);
  assert.equal(JSON.stringify(body).includes('secret'), false);
});

test('?edit adds the loader; login sets an HttpOnly cookie; logged in pages get the loader without ?edit', async () => {
  const { run } = setup();
  const html = await (await run('/?edit')).text();
  assert.match(html, /<script src="\/__es\/web" data-authed="0" data-mode="auto" defer><\/script><\/body>/);
  const bad = await run('/__es/api/login', post({ password: 'nope' }));
  assert.equal(bad.status, 401);
  const forged = await run('/__es/api/login', post({ password: 'correct horse' }, { headers: { Origin: 'https://evil.test' } }));
  assert.equal(forged.status, 403);
  const res = await run('/__es/api/login', post({ password: 'correct horse' }));
  assert.match(res.headers.get('set-cookie'), /es_auth=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict/);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await run('/', { headers: { cookie } });
  assert.match(await page.text(), /data-authed="1"/);
  assert.equal(page.headers.get('content-length'), null);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(await (await run('/__es/web')).text(), 'CLIENT');
  assert.equal(await (await run('/__es/editor')).text(), 'EDITOR');
});

test('save queues the edits on the branch with the host\'s skip-build note; status reads the result', async () => {
  const { run, calls, files } = setup();
  const cookie = await login(run);
  const unauth = await run('/__es/api/save', post({ page: '/', changes: [] }));
  assert.equal(unauth.status, 401);
  const res = await run('/__es/api/save', post({ page: '/about/', mode: 'dom', changes: [
    { id: 0, before: 'Hello', after: 'Hi' },
    { id: 3, error: 'Images can\'t be changed here yet' },
  ] }, { headers: { cookie } }));
  const body = await res.json();
  assert.equal(body.pending, true);
  assert.deepEqual(body.applied, [0]);
  assert.equal(body.errors.length, 1);
  const put = calls.find((c) => c.method === 'PUT');
  assert.match(put.url, /^https:\/\/api\.github\.com\/repos\/me\/site\/contents\/\.editstatic\/pending\/\d+-[0-9a-f]{8}\.json$/);
  assert.equal(put.headers.Authorization, 'Bearer ghp_test');
  const sent = JSON.parse(put.body);
  assert.equal(sent.branch, 'staging');
  assert.equal(sent.message, 'EditStatic: 1 edit on /about/ [skip netlify]');
  const job = JSON.parse(Buffer.from(sent.content, 'base64').toString());
  assert.deepEqual(job.changes, [{ before: 'Hello', after: 'Hi' }]);

  assert.deepEqual(await (await run(`/__es/api/status?id=${body.id}`, { headers: { cookie } })).json(), { done: false });
  files.set(`.editstatic/results/${body.id}.json`, { content: Buffer.from(JSON.stringify({ done: true, applied: 1, errors: [] })).toString('base64') });
  assert.deepEqual(await (await run(`/__es/api/status?id=${body.id}`, { headers: { cookie } })).json(), { done: true, applied: 1, errors: [] });
});

test('static pages: a save against an older version of the page is refused', async () => {
  const { run } = setup();
  const cookie = await login(run);
  const res = await run('/__es/api/save', post({ page: '/', mode: 'static', version: 'old', changes: [{ id: 0, before: 'Hello', after: 'Hi' }] }, { headers: { cookie } }));
  assert.equal(res.status, 409);
});

test('page menu comes from the sitemap', async () => {
  const { run } = setup();
  const cookie = await login(run);
  const { pages } = await (await run('/__es/api/pages', { headers: { cookie } })).json();
  assert.deepEqual(pages, [{ path: '/', title: 'Home' }, { path: '/about/', title: 'About' }]);
});
