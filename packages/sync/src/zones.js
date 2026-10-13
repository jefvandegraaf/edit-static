// Turns source files into "zones": runs of visible text with a map back to the exact source
// characters they came from. A zone knows where markup interrupts the text (breaks: a tag, a
// **bold** marker, a JSX element) and where a block ends (barriers: a blank line, a </p>), so an
// edit can be matched on the words a visitor sees and written back without touching the markup.
//
// Zone kinds:
//   html   a whole .html file: edits are written back as HTML (formatting changes allowed)
//   text   everything else (markdown, JSON and YAML values, JS strings, JSX text): only the words
//          between markup are rewritten, each piece escaped for the syntax it sits in
import { parse, parseExpression } from '@babel/parser';

const ENT = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”',
  ldquo: '“', mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', copy: '©',
  trade: '™', reg: '®', deg: '°', eacute: 'é', euro: '€', pound: '£', bull: '•',
  laquo: '«', raquo: '»', shy: '', zwj: '', zwnj: '',
};
export function decodeEntity(name) {
  if (name[0] === '#') {
    const n = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : null;
  }
  return Object.prototype.hasOwnProperty.call(ENT, name) ? ENT[name] : null;
}

// Elements that end a block of text: a match never runs across one.
const BLOCK = /^(p|div|h[1-6]|li|ul|ol|dl|dt|dd|section|article|header|footer|main|nav|aside|blockquote|table|thead|tbody|tr|td|th|figure|figcaption|form|fieldset|details|summary|hr|pre|title|option|button|label)$/i;
const INVISIBLE = new Set(['⁠', '​', '­', '﻿']);

export class Zone {
  constructor(file, kind, extra = {}) {
    Object.assign(this, { file, kind, s: '', map: [], piece: [], pieces: [], breaks: new Set() }, extra);
  }
  // one source run that is escaped one way (a JSX text, a string literal, a markdown paragraph)
  addPiece(info) { this.pieces.push(info); return this.pieces.length - 1; }
  push(ch, a, b, p) {
    if (/\s/.test(ch) || ch === ' ') {
      const last = this.s[this.s.length - 1];
      if (last === ' ') { this.map[this.map.length - 1][1] = b; return; }
      if (last === '\0' || !this.s.length) return;
      ch = ' ';
    }
    this.s += ch; this.map.push([a, b]); this.piece.push(p);
  }
  brk() { this.breaks.add(this.s.length); }
  bar(at = 0) {
    if (this.s.endsWith(' ')) { this.s = this.s.slice(0, -1); this.map.pop(); this.piece.pop(); }
    if (this.s.length && !this.s.endsWith('\0')) { this.s += '\0'; this.map.push([at, at]); this.piece.push(-1); }
  }
}

/*
 * Appends the visible text of src[from, to) to a zone.
 *   tags      strip HTML tags (a tag is a break, a block tag a barrier, <br> a space)
 *   entities  decode &amp; &#39; ...
 *   escapes   'js' (\n \" é ...), 'yaml1' ('' inside single quotes)
 *   markdown  markdown markers are breaks, block starts and blank lines are barriers
 */
export function addText(zone, src, from, to, opts = {}) {
  const { tags = true, entities = true, escapes = null, markdown = false } = opts;
  const p = zone.addPiece({ start: from, end: to, ...opts.piece });
  let lineStart = true;
  let fence = false;
  for (let i = from; i < to;) {
    const c = src[i];
    if (markdown && lineStart) {
      // block-level syntax at the start of a line
      const rest = src.slice(i, Math.min(to, i + 200));
      const line = rest.split('\n')[0];
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; zone.bar(i); i += line.length; continue; }
      if (fence) { i += line.length + 1; continue; }
      if (/^\s*$/.test(line)) { zone.bar(i); i += line.length + 1; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { zone.bar(i); i += line.length; continue; }
      if (/^\s{0,3}\[[^\]]+\]:\s/.test(line)) { zone.bar(i); i += line.length; continue; }
      const m = /^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/.exec(line);
      if (m) { zone.bar(i); i += m[0].length; lineStart = false; continue; }
      lineStart = false;
    }
    if (c === '\n') { lineStart = true; zone.push(' ', i, i + 1, p); i++; continue; }
    if (tags && c === '<' && src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i);
      i = e > -1 && e < to ? e + 3 : to;
      continue;
    }
    if (tags && c === '<') {
      const j = src.indexOf('>', i);
      const head = src.slice(i, i + 2);
      if (j > -1 && j < to && /^<[a-zA-Z/!]/.test(head)) {
        const name = (/^<\/?([a-zA-Z][\w-]*)/.exec(src.slice(i, j)) || [])[1] || '';
        if (/^br$/i.test(name)) { zone.push(' ', i, j + 1, p); zone.brk(); }
        else if (BLOCK.test(name)) zone.bar(i);
        else zone.brk();
        // the inside of these is never body text
        if (/^<(script|style|head|title|svg|template|noscript)\b/i.test(src.slice(i, j))) {
          const close = src.toLowerCase().indexOf('</' + name.toLowerCase(), j);
          i = close > -1 && close < to ? src.indexOf('>', close) + 1 : j + 1;
        } else i = j + 1;
        continue;
      }
    }
    if (entities && c === '&') {
      const m = /^&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/.exec(src.slice(i, i + 12));
      const d = m && decodeEntity(m[1]);
      if (d != null) { if (d) zone.push(d, i, i + m[0].length, p); i += m[0].length; continue; }
    }
    if (escapes === 'js' && c === '\\') {
      const n = src[i + 1];
      if (n === 'u' && src[i + 2] === '{') { const e = src.indexOf('}', i); zone.push(String.fromCodePoint(parseInt(src.slice(i + 3, e), 16)), i, e + 1, p); i = e + 1; continue; }
      if (n === 'u') { zone.push(String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)), i, i + 6, p); i += 6; continue; }
      if (n === 'x') { zone.push(String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)), i, i + 4, p); i += 4; continue; }
      if (n === '\n') { i += 2; continue; }
      const e = { n: ' ', t: ' ', r: '' }[n];
      if (e !== undefined) { if (e) zone.push(e, i, i + 2, p); i += 2; continue; }
      zone.push(n, i, i + 2, p); i += 2; continue;
    }
    if (escapes === 'yaml1' && c === "'" && src[i + 1] === "'") { zone.push("'", i, i + 2, p); i += 2; continue; }
    if (markdown) {
      if (c === '\\' && /[!-/:-@[-`{-~]/.test(src[i + 1] || '')) { zone.push(src[i + 1], i, i + 2, p); i += 2; continue; }
      if (c === '!' && src[i + 1] === '[') {
        // an image: alt text isn't visible text, skip the whole ![alt](url)
        const m = /^!\[[^\]]*\]\([^)]*\)/.exec(src.slice(i, Math.min(to, i + 2000)));
        if (m) { zone.brk(); i += m[0].length; continue; }
      }
      if (c === '[') { zone.brk(); i++; continue; }
      if (c === ']') {
        const m = /^\](\([^)]*\)|\[[^\]]*\])?/.exec(src.slice(i, Math.min(to, i + 2000)));
        zone.brk(); i += m[0].length; continue;
      }
      if (c === '`') { zone.brk(); i++; continue; }
      if ((c === '*' || c === '~') && src[i + 1] === c) { zone.brk(); i += 2; continue; }
      if (c === '_' && src[i + 1] === '_') { zone.brk(); i += 2; continue; }
      if (c === '*' && !(/\s/.test(src[i - 1] || ' ') && /\s/.test(src[i + 1] || ' '))) { zone.brk(); i++; continue; }
      if (c === '_' && !(/\w/.test(src[i - 1] || '') && /\w/.test(src[i + 1] || ''))) { zone.brk(); i++; continue; }
      if (c === '|') { zone.brk(); zone.push(' ', i, i + 1, p); i++; continue; }
    }
    if (INVISIBLE.has(c)) { i++; continue; }
    zone.push(c, i, i + 1, p);
    i++;
  }
  return p;
}

// ---------- file types ----------

export function htmlZones(file, text) {
  const z = new Zone(file, 'html');
  addText(z, text, 0, text.length, { piece: { esc: 'html' } });
  return [z];
}

// where frontmatter ends: --- YAML --- or --- {JSON} ---
function frontmatter(text) {
  if (!text.startsWith('---')) return null;
  const m = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(3));
  if (!m) return null;
  return { from: 3, to: 3 + m.index, end: 3 + m.index + m[0].length };
}

export function markdownZones(file, text) {
  const zones = [];
  const fm = frontmatter(text);
  let bodyFrom = 0;
  if (fm) {
    bodyFrom = fm.end;
    const inner = text.slice(fm.from, fm.to);
    if (/^\s*\{/.test(inner)) zones.push(...jsonZones(file, text, fm.from, fm.to, { meta: true }));
    else zones.push(...yamlZones(file, text, fm.from, fm.to));
  }
  const z = new Zone(file, 'text');
  addText(z, text, bodyFrom, text.length, { markdown: true, piece: { esc: 'markdown' } });
  zones.push(z);
  return zones;
}

// single-line YAML scalars: key: value, - value, "double", 'single' or plain
export function yamlZones(file, text, from = 0, to = text.length) {
  const zones = [];
  let at = from;
  for (const line of text.slice(from, to).split('\n')) {
    const m = /^(\s*(?:-\s+)?(?:[\w$-]+\s*:\s+)?)(.*?)\s*$/.exec(line);
    const lead = m[1];
    let value = m[2];
    const vs = at + lead.length;
    at += line.length + 1;
    if (!value || /^[|>&*!{[]/.test(value) || !/[a-zA-Z]/.test(value) || (!lead.includes(':') && !lead.trim().startsWith('-'))) continue;
    const z = new Zone(file, 'text', { meta: true });
    if (value[0] === '"' && value.endsWith('"') && value.length > 1) addText(z, text, vs + 1, vs + value.length - 1, { tags: false, entities: false, escapes: 'js', piece: { esc: 'yaml2' } });
    else if (value[0] === "'" && value.endsWith("'") && value.length > 1) addText(z, text, vs + 1, vs + value.length - 1, { tags: false, entities: false, escapes: 'yaml1', piece: { esc: 'yaml1' } });
    else {
      value = value.replace(/\s+#.*$/, '');
      addText(z, text, vs, vs + value.length, { tags: false, entities: false, piece: { esc: 'yaml0', whole: [vs, vs + value.length] } });
    }
    zones.push(z);
  }
  return zones;
}

const looksHtml = (s) => /<[a-zA-Z/][^>]*>|&[a-zA-Z#][\w]*;/.test(s);
function stringZone(file, text, node, extra = {}) {
  const from = node.start + 1, to = node.end - 1;
  const raw = text.slice(from, to);
  const z = new Zone(file, 'text', extra);
  const html = looksHtml(raw);
  addText(z, text, from, to, { tags: html, entities: html, escapes: 'js', piece: { esc: extra.esc || 'js', quote: text[node.start], html } });
  return z;
}

export function jsonZones(file, text, from = 0, to = text.length, extra = {}) {
  let ast;
  try { ast = parseExpression(text.slice(from, to), { startIndex: from }); } catch { return []; }
  const zones = [];
  walk(ast, null, null, (node, parent, key) => {
    if (node.type === 'StringLiteral' && !(parent?.type === 'ObjectProperty' && key === 'key') && /[a-zA-Z]/.test(node.value)) {
      zones.push(stringZone(file, text, node, { ...extra, esc: 'json' }));
    }
  });
  return zones;
}

// ---------- JavaScript / TypeScript / JSX ----------

// Inline tags a JSX text unit may contain (mirrors @editstatic/core regions).
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'img', 'svg']);
// String props that never hold visible text
const NOT_TEXT_ATTR = /^(className|class|id|key|ref|href|to|src|srcSet|type|variant|size|style|role|htmlFor|target|rel|d|viewBox|fill|stroke|xmlns|width|height|as|method|action|lang|dir|tabIndex|loading|decoding|sizes|media|crossOrigin|referrerPolicy|autoComplete|inputMode|pattern|form|data-.*|aria-(?!label).*)$/;
const CLASS_FN = /^(cn|clsx|classNames|cva|twMerge|tw|require|import)$/;

export function walk(node, parent, key, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent, key) === false) return;
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'range' || k.endsWith('Comments') || k === 'tokens') continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walk(c, node, k, visit);
    else if (v && typeof v === 'object') walk(v, node, k, visit);
  }
}

const tagName = (el) => {
  const n = el.openingElement?.name;
  if (!n) return '';
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return 'X.' + (n.property?.name || '');
  return '';
};
const isComponent = (name) => /^[A-Z]|\./.test(name);
const plainStr = (e) => e && (e.type === 'StringLiteral' || (e.type === 'TemplateLiteral' && !e.expressions.length));
const textOf = (e) => (e.type === 'StringLiteral' ? e.value : e.quasis[0].value.cooked || '');

function inlineChildren(children) {
  return children.every((c) => {
    if (c.type === 'JSXText') return true;
    if (c.type === 'JSXExpressionContainer') return c.expression.type === 'JSXEmptyExpression' || plainStr(c.expression);
    if (c.type === 'JSXElement') {
      const name = tagName(c);
      if (!name) return false;
      if (!isComponent(name) && !INLINE.has(name)) return false;
      return inlineChildren(c.children);
    }
    return false;
  });
}
const ownText = (children) => children.some((c) =>
  (c.type === 'JSXText' && c.value.trim()) || (c.type === 'JSXExpressionContainer' && plainStr(c.expression) && textOf(c.expression).trim()));

function addJsxChildren(z, text, children) {
  for (const c of children) {
    if (c.type === 'JSXText') addText(z, text, c.start, c.end, { tags: false, piece: { esc: 'jsx' } });
    else if (c.type === 'JSXExpressionContainer' && plainStr(c.expression)) {
      const e = c.expression;
      const node = e.type === 'StringLiteral' ? e : { start: e.quasis[0].start - 1, end: e.quasis[0].end + 1 };
      addText(z, text, node.start + 1, node.end - 1, { tags: false, entities: false, escapes: 'js', piece: { esc: 'js', quote: text[node.start] } });
    } else if (c.type === 'JSXElement') {
      if (tagName(c) === 'br') { z.push(' ', c.start, c.end, -1); z.brk(); continue; }
      z.brk();
      addJsxChildren(z, text, c.children);
      z.brk();
    }
  }
}

export function scriptZones(file, text) {
  const ts = /\.(c|m)?tsx?$/.test(file), jsx = !/\.(c|m)?ts$/.test(file);
  let ast;
  try {
    ast = parse(text, { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, plugins: [...(jsx ? ['jsx'] : []), ...(ts ? ['typescript'] : []), 'decorators-legacy', 'importAttributes'] });
  } catch { return []; }
  const zones = [];
  walk(ast.program, null, null, (node, parent, key) => {
    const t = node.type;
    if (t === 'ImportDeclaration' || t === 'ExportAllDeclaration' || t.startsWith('TS') && t !== 'TSAsExpression' && t !== 'TSSatisfiesExpression' && t !== 'TSNonNullExpression') return false;
    if (t === 'CallExpression' && CLASS_FN.test(node.callee?.name || '')) return false;
    if (t === 'JSXAttribute' && NOT_TEXT_ATTR.test(node.name?.name || '')) return false;
    if (t === 'JSXElement' || t === 'JSXFragment') {
      if (ownText(node.children) && inlineChildren(node.children)) {
        const z = new Zone(file, 'text', { unit: true, line: node.loc?.start.line });
        addJsxChildren(z, text, node.children);
        zones.push(z);
      }
      return;
    }
    if (t === 'JSXExpressionContainer' && parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment') && key === 'children') {
      if (plainStr(node.expression)) return false; // part of the element's text unit
      return;
    }
    if (t === 'StringLiteral' && !(key === 'key' && (parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod')) && /[a-zA-Z]/.test(node.value)) {
      const z = stringZone(file, text, node);
      z.line = node.loc?.start.line;
      zones.push(z);
    }
    if (t === 'TemplateLiteral' && !node.expressions.length && /[a-zA-Z]/.test(node.quasis[0].value.raw)) {
      const q = node.quasis[0];
      const z = new Zone(file, 'text', { line: node.loc?.start.line });
      const html = looksHtml(q.value.raw);
      addText(z, text, q.start, q.end, { tags: html, entities: html, escapes: 'js', piece: { esc: 'tpl', html } });
      zones.push(z);
    }
  });
  return zones;
}

export function zonesFor(file, text) {
  if (/\.html?$/i.test(file)) return htmlZones(file, text);
  if (/\.(md|mdx|markdown)$/i.test(file)) return markdownZones(file, text);
  if (/\.json$/i.test(file)) return jsonZones(file, text);
  if (/\.ya?ml$/i.test(file)) return yamlZones(file, text);
  if (/\.(c|m)?(j|t)sx?$/i.test(file)) return scriptZones(file, text);
  return [];
}

// The visible text of a fragment of HTML (what the editor sends), split where markup interrupts it.
// Attribute-less <span>s mean nothing visually (browsers add them while editing) and don't split.
export function htmlSegments(html) {
  const z = new Zone('', 'text');
  addText(z, String(html).replace(/<\/?span\s*>/gi, ''), 0, String(html).replace(/<\/?span\s*>/gi, '').length, {});
  const segs = [];
  let cur = '';
  for (let i = 0; i <= z.s.length; i++) {
    if (i === z.s.length || z.breaks.has(i) || z.s[i] === '\0') {
      segs.push(cur);
      cur = '';
      if (i < z.s.length && z.s[i] === '\0') continue;
    }
    if (i < z.s.length && z.s[i] !== '\0') cur += z.s[i];
  }
  return segs.filter((s) => s.trim());
}
export const visible = (html) => htmlSegments(html).join('').replace(/\s+/g, ' ').trim();
