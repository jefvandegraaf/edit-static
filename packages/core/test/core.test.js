import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRegions, annotate, applyEdits, sanitizeInline, hashText } from '../src/index.js';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>Test</title>
  <style>p { color: red }</style>
</head>
<body>
  <!-- header -->
  <nav class="menu">
    <a href="/">Home</a>
    <a href="/about/">About   us</a>
  </nav>
  <h1 class="hero">Roofing done <em>right</em></h1>
  <div class="card">
    <h3>Repairs</h3>
    <p>Leaks fixed
       same day.</p>
  </div>
  <img src="/a.jpg" alt="Old roof" width="800" height="600" srcset="/a-2x.jpg 2x">
  <picture><source srcset="/b.webp" type="image/webp"><img src="/b.jpg"></picture>
  <div data-edit="off"><p>Locked</p></div>
  <div class="price" data-edit><strong>$49</strong><span>/mo</span></div>
  <svg><text>No</text></svg>
  <script>document.title = 'x'</script>
</body>
</html>
`;

test('finds text and image regions in source order', () => {
  const { regions } = findRegions(PAGE);
  const summary = regions.map(r => r.kind === 'text' ? r.tag : 'img');
  assert.deepEqual(summary, ['a', 'a', 'h1', 'h3', 'p', 'img', 'img', 'div']);
});

test('nav is not a region, its links are; locked and svg content is skipped', () => {
  const { regions } = findRegions(PAGE);
  const texts = regions.filter(r => r.kind === 'text').map(r => PAGE.slice(r.innerStart, r.innerEnd));
  assert.ok(!texts.some(t => t.includes('Locked')));
  assert.ok(!texts.some(t => t.includes('No')));
  assert.ok(texts.includes('Roofing done <em>right</em>'));
});

test('annotate tags regions and injects before </body>', () => {
  const { html } = annotate(PAGE, { inject: '<script src="/e.js"></script>' });
  assert.match(html, /<h1 class="hero" data-es="2">/);
  assert.match(html, /<img src="\/b.jpg" data-es="6">/);
  assert.match(html, /<script src="\/e.js"><\/script><\/body>/);
});

test('a text edit changes only that region, every other byte stays', () => {
  const { regions } = findRegions(PAGE);
  const p = regions.find(r => r.tag === 'p');
  const { html, applied, errors } = applyEdits(PAGE, [{ id: p.id, html: 'Leaks fixed <b>today</b>.' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(applied, [p.id]);
  assert.equal(html, PAGE.slice(0, p.innerStart) + 'Leaks fixed <b>today</b>.' + PAGE.slice(p.innerEnd));
});

test('CRLF files keep their line endings and offsets line up', () => {
  const crlf = PAGE.replace(/\n/g, '\r\n');
  const { regions } = findRegions(crlf);
  const h3 = regions.find(r => r.tag === 'h3');
  assert.equal(crlf.slice(h3.innerStart, h3.innerEnd), 'Repairs');
  const { html } = applyEdits(crlf, [{ id: h3.id, html: 'Roof repairs' }]);
  assert.equal(html, crlf.replace('<h3>Repairs</h3>', '<h3>Roof repairs</h3>'));
  assert.equal(html.split('\r\n').length, crlf.split('\r\n').length);
});

test('image edits replace src, drop srcset and picture sources, update size and alt', () => {
  const { regions } = findRegions(PAGE);
  const [img1, img2] = regions.filter(r => r.kind === 'image');
  const { html } = applyEdits(PAGE, [
    { id: img1.id, src: '/new.jpg', width: 1200, height: 900, alt: 'New "roof"' },
    { id: img2.id, src: '/c.jpg', alt: 'Shingles' },
  ]);
  assert.match(html, /<img src="\/new.jpg" alt="New &quot;roof&quot;" width="1200" height="900">/);
  assert.match(html, /<picture><img src="\/c.jpg" alt="Shingles"><\/picture>/);
});

test('unsafe edits are cleaned or refused', () => {
  const { regions } = findRegions(PAGE);
  const h1 = regions.find(r => r.tag === 'h1');
  const img = regions.find(r => r.kind === 'image');
  const { html, errors } = applyEdits(PAGE, [
    { id: h1.id, html: 'Hi<script>alert(1)</script> <a href="javascript:alert(1)" onclick="x()">there</a><img src=x onerror=alert(1)>' },
    { id: img.id, src: ' javascript:alert(1)' },
  ]);
  assert.match(html, /<h1 class="hero">Hi <a>there<\/a><\/h1>/);
  assert.deepEqual(errors, [{ id: img.id, error: 'Unsafe image URL' }]);
});

test('sanitizer keeps inline formatting and turns browser blocks into line breaks', () => {
  assert.equal(sanitizeInline('One<div>Two</div><div>Three</div>'), 'One<br>Two<br>Three');
  assert.equal(sanitizeInline('<span style="color:red" class="k">A&nbsp;B</span> &amp; <i>c</i>'), '<span class="k">A&nbsp;B</span> &amp; <i>c</i>');
  assert.equal(sanitizeInline('<br>'), '');
});

test('browser-typed non-breaking spaces become plain ones; word glue stays', () => {
  assert.equal(sanitizeInline('every&nbsp; and storm&nbsp;'), 'every and storm');
  assert.equal(sanitizeInline('Roofs that last through every&nbsp;winter'), 'Roofs that last through every&nbsp;winter');
  assert.equal(sanitizeInline('a   b'), 'a b');
});

test('unknown region ids are reported, not applied', () => {
  const { html, errors } = applyEdits(PAGE, [{ id: 99, html: 'x' }]);
  assert.equal(html, PAGE);
  assert.deepEqual(errors, [{ id: 99, error: 'No such region' }]);
});

test('hashText is stable', async () => {
  assert.equal(await hashText('abc'), await hashText('abc'));
  assert.notEqual(await hashText('abc'), await hashText('abd'));
});
