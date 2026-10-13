import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSync } from '../src/index.js';
import { processQueue } from '../src/apply.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

function copy(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-sync-'));
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true, filter: (f) => !/node_modules|[\\/]dist$/.test(f) });
  return dir;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

test('JSX: a heading with a styled span keeps its markup, only the words change', async () => {
  const dir = copy('react-site');
  const [r] = await createSync(dir).sync({ page: '/', changes: [{
    before: 'Websites that<span class="block text-primary">sell while you sleep</span>',
    after: 'Websites that<span class="block text-primary">sell while you surf</span>',
  }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.file, 'src/components/Hero.tsx');
  const src = read(dir, 'src/components/Hero.tsx');
  assert.match(src, /<span className="block text-primary">sell while you surf<\/span>/);
  assert.match(src, /\n {8}Websites that\n/);
});

test('JSX: a paragraph wrapped over two lines is rewritten as one line', async () => {
  const dir = copy('react-site');
  const [r] = await createSync(dir).sync({ page: '/', changes: [{
    before: 'We build fast, beautiful sites for small businesses. No templates, no monthly fees, no nonsense.',
    after: 'We build fast sites for small businesses. No templates & no {fees}.',
  }] });
  assert.equal(r.ok, true, r.error);
  assert.match(read(dir, 'src/components/Hero.tsx'), /<p className="lead">\n {8}We build fast sites for small businesses\. No templates & no &#123;fees&#125;\.\n {6}<\/p>/);
});

test('JSX: text next to an icon component; the icon stays', async () => {
  const dir = copy('react-site');
  const [r] = await createSync(dir).sync({ page: '/', changes: [{ before: 'See our work', after: 'See our "best" work' }] });
  assert.equal(r.ok, true, r.error);
  assert.match(read(dir, 'src/components/Hero.tsx'), /<Button variant="outline">See our "best" work<\/Button>/);
});

test('strings in data arrays: double, single and template quotes are escaped for their syntax', async () => {
  const dir = copy('react-site');
  const results = await createSync(dir).sync({ page: '/', changes: [
    { before: 'Lightning fast', after: 'Really "fast"' },
    { before: 'Clear calls to action, so visitors know what to do next.', after: "Clear calls to action, so visitors know what's next." },
    { before: 'Change any word yourself, right on the page.', after: 'Change any `word` yourself, ${right} here.' },
  ] });
  assert.deepEqual(results.map((r) => r.ok), [true, true, true], JSON.stringify(results));
  const src = read(dir, 'src/components/Features.tsx');
  assert.match(src, /title: "Really \\"fast\\"",/);
  assert.match(src, /description: 'Clear calls to action, so visitors know what\\'s next\.',/);
  assert.match(src, /description: `Change any \\`word\\` yourself, \\\$\{right\} here\.`,/);
});

test('entities and apostrophes in JSX text survive, the edited words change', async () => {
  const dir = copy('react-site');
  const [r] = await createSync(dir).sync({ page: '/', changes: [{
    before: '“They doubled our leads in a month. It\'s the best money we\'ve spent on the business.”',
    after: '“They tripled our leads in a month. It\'s the best money we\'ve spent on the business.”',
  }] });
  assert.equal(r.ok, true, r.error);
  const src = read(dir, 'src/components/Testimonial.tsx');
  assert.match(src, /They tripled our leads/);
  assert.doesNotMatch(src, /doubled/);
});

test('a link inside the text: words on both sides can change, the link stays', async () => {
  const dir = copy('react-site');
  const [r] = await createSync(dir).sync({ page: '/', changes: [{
    before: 'Made with care in Lisbon. <a href="mailto:hello@acme.example">Say hello</a>',
    after: 'Made with love in Porto. <a href="mailto:hello@acme.example">Write to us</a>',
  }] });
  assert.equal(r.ok, true, r.error);
  const src = read(dir, 'src/components/Footer.tsx');
  assert.match(src, /Made with love in Porto\.\{" "\}\n {6}<a href="mailto:hello@acme\.example">Write to us<\/a>/);
});

test('refuses: text made by code, text in two places, formatting changes', async () => {
  const dir = copy('react-site');
  const before = fs.readFileSync(path.join(dir, 'src/components/Hero.tsx'), 'utf8');
  const [code, twice, bold] = await createSync(dir).sync({ page: '/', changes: [
    { before: '© 2026 Acme Studio. All rights reserved.', after: '© 2026 Acme. All rights reserved.' },
    { before: 'Get started ', after: 'Start now' },
    { before: 'See our work', after: 'See <strong>our</strong> work' },
  ] });
  assert.equal(code.ok, false);
  assert.match(code.error, /made by the site's code/);
  assert.equal(twice.ok, false);
  assert.match(twice.error, /2 places \(src\/components\/Hero\.tsx:16, src\/components\/Navbar\.tsx:20\)/);
  assert.equal(bold.ok, false);
  assert.match(bold.error, /Only the words/);
  assert.equal(read(dir, 'src/components/Hero.tsx'), before);
});

test('a page\'s own file wins: "About" on /about is the nav link, "About us" is the heading', async () => {
  const dir = copy('react-site');
  const [r] = await createSync(dir).sync({ page: '/about', changes: [{ before: 'About us', after: 'Who we are' }] });
  assert.equal(r.ok, true, r.error);
  assert.match(read(dir, 'src/pages/About.tsx'), /<h1>Who we are<\/h1>/);
  assert.match(read(dir, 'src/components/Navbar.tsx'), /name: "About"/);
});

test('markdown: words around bold and a link change, the markdown stays; frontmatter loses to body', async () => {
  const dir = copy('react-site');
  const results = await createSync(dir).sync({ page: '/blog/hello/', changes: [
    {
      before: 'Page builders are <strong>great for a first draft</strong>, but every extra plugin adds weight. Read <a href="/speed/">our speed checklist</a> before you pick one.',
      after: 'Page builders are <strong>fine for a first draft</strong>, but every plugin adds weight. Read <a href="/speed/">the speed checklist</a> first.',
    },
    { before: 'Why we stopped using page builders', after: 'Why we quit page builders' },
    { before: 'Fewer scripts', after: '- not a list' },
  ] });
  assert.deepEqual(results.map((r) => r.ok), [true, true, true], JSON.stringify(results));
  const md = read(dir, 'content/blog/hello.md');
  assert.match(md, /Page builders are \*\*fine for a first draft\*\*, but every plugin adds weight\. Read \[the speed checklist\]\(\/speed\/\) first\./);
  assert.match(md, /^# Why we quit page builders$/m);
  assert.match(md, /^title: "Why we stopped using page builders"$/m);
  assert.match(md, /^- \\- not a list$/m);
});

test('plain HTML site: formatting edits are written as HTML into the page file', async () => {
  const dir = copy('sample-site');
  const [r] = await createSync(dir).sync({ page: '/', changes: [{
    before: 'Roofs that last through every winter',
    after: 'Roofs that last <em>every</em> winter',
  }] });
  assert.equal(r.ok, true, r.error);
  assert.match(read(dir, 'index.html'), /<h1>Roofs that last <em>every<\/em> winter<\/h1>/);
});

test('apply: queued edits are written, results recorded, the queue emptied', async () => {
  const dir = copy('react-site');
  fs.mkdirSync(path.join(dir, '.editstatic/pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.editstatic/pending/1-abc.json'), JSON.stringify({
    id: '1-abc', page: '/', changes: [
      { before: 'See our work', after: 'Our work' },
      { before: 'Get started ', after: 'Go' },
    ],
  }));
  const log = [];
  const out = await processQueue(dir, { build: false, log: (m) => log.push(m) });
  assert.equal(out.applied, 1);
  assert.equal(fs.existsSync(path.join(dir, '.editstatic/pending/1-abc.json')), false);
  const res = JSON.parse(read(dir, '.editstatic/results/1-abc.json'));
  assert.equal(res.done, true);
  assert.equal(res.applied, 1);
  assert.deepEqual(res.files, ['src/components/Hero.tsx']);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].error, /2 places/);
  assert.match(read(dir, 'src/components/Hero.tsx'), />Our work</);
});
