// Finds an edited text in a zone and writes the new words back in the right syntax.
import { htmlSegments } from './zones.js';

const wsFree = (s) => s.replace(/\s+/g, '');
const tidy = (s) => s.replace(/\s+/g, ' ').trim();
const isWord = (ch) => /[\p{L}\p{N}]/u.test(ch || '');

// Every place the needle (the visible text of the edited element) occurs in a zone. Whitespace is
// ignored: JSX drops the line break between "Ship faster" and <span>with AI</span>, so the page
// can read "Ship fasterwith AI" where the source reads "Ship faster with AI".
export function findHits(zone, needle) {
  const n = wsFree(needle);
  if (!n) return [];
  let wf = '';
  const idx = [];
  for (let i = 0; i < zone.s.length; i++) if (zone.s[i] !== ' ') { wf += zone.s[i]; idx.push(i); }
  const hits = [];
  for (let k = wf.indexOf(n); k > -1; k = wf.indexOf(n, k + 1)) {
    const a = idx[k], b = idx[k + n.length - 1] + 1;
    // not half a word: "AI" is not in "MAIL"
    const startOk = a === 0 || zone.breaks.has(a) || !(isWord(zone.s[a - 1]) && isWord(zone.s[a]));
    const endOk = b === zone.s.length || zone.breaks.has(b) || !(isWord(zone.s[b - 1]) && isWord(zone.s[b]));
    if (startOk && endOk) hits.push({ zone, a, b, whole: isWhole(zone, a, b) });
  }
  return hits;
}

// the hit is the whole element / string / paragraph, not a few words inside a longer one
function isWhole(z, a, b) {
  let i = a - 1;
  while (i >= 0 && z.s[i] === ' ') i--;
  let j = b;
  while (j < z.s.length && z.s[j] === ' ') j++;
  return (i < 0 || z.s[i] === '\0') && (j >= z.s.length || z.s[j] === '\0');
}

export const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

// ---------- writing ----------
const htmlEsc = (t) => t.replace(/&(?=[a-zA-Z#][\w]*;)|&(?=\s)|&$/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ESC = {
  jsx: (t) => t.replace(/&(?=[a-zA-Z#][\w]*;)/g, '&amp;').replace(/[{}<>]/g, (c) => ({ '{': '&#123;', '}': '&#125;', '<': '&lt;', '>': '&gt;' })[c]),
  js: (t, p) => (p.html ? htmlEsc(t) : t).replace(/\\/g, '\\\\').split(p.quote).join('\\' + p.quote).replace(/\n/g, '\\n'),
  json: (t, p) => JSON.stringify(p.html ? htmlEsc(t) : t).slice(1, -1),
  tpl: (t, p) => (p.html ? htmlEsc(t) : t).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'),
  yaml2: (t) => JSON.stringify(t).slice(1, -1),
  yaml1: (t) => t.replace(/'/g, "''"),
  yaml0: (t) => (/^[\s\-?:,[\]{}#&*!|>'"%@`]|:(\s|$)|\s#/.test(t) ? null : t),
  markdown: (t) => {
    t = t.replace(/&(?=[a-zA-Z#][\w]*;)/g, '&amp;').replace(/</g, '&lt;');
    // one * or _ is just a character; two could turn into emphasis
    for (const ch of ['*', '_', '`']) if (t.split(ch).length > 2) t = t.split(ch).join('\\' + ch);
    return t;
  },
};

// widen [start, end) over tags that open just before it or close just after it, so the span holds whole elements
function balance(text, start, end) {
  for (let guard = 0; guard < 20; guard++) {
    const stack = [];
    let closers = 0;
    for (const m of text.slice(start, end).matchAll(/<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>/g)) {
      if (m[3] || /^(br|img|hr|wbr|input|source)$/i.test(m[2])) continue;
      if (!m[1]) stack.push(m[2].toLowerCase());
      else if (stack.length && stack[stack.length - 1] === m[2].toLowerCase()) stack.pop();
      else closers++;
    }
    if (!closers && !stack.length) return [start, end];
    if (closers) {
      const m = /<([a-zA-Z0-9]+)\b[^>]*>\s*$/.exec(text.slice(Math.max(0, start - 400), start));
      if (!m) return null;
      start -= m[0].length;
    } else {
      const m = /^\s*<\/([a-zA-Z0-9]+)\s*>/.exec(text.slice(end, end + 40));
      if (!m) return null;
      end += m[0].length;
    }
  }
  return null;
}

// the pieces of text inside a hit, split where markup interrupts it, each trimmed to its words
function segmentsOf(z, a, b) {
  const cuts = [a, ...[...z.breaks].filter((p) => p > a && p < b).sort((x, y) => x - y), b];
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    let x = cuts[i], y = cuts[i + 1];
    const raw = z.s.slice(x, y);
    while (x < y && z.s[x] === ' ') x++;
    while (y > x && z.s[y - 1] === ' ') y--;
    if (x < y) out.push({ s: raw, x, y });
  }
  return out;
}

// boundaries of each segment in whitespace-free characters: [0, 5, 12]
function bounds(list) {
  let pos = 0;
  const out = [0];
  for (const s of list) { pos += wsFree(s).length; out.push(pos); }
  return out;
}

/**
 * Plans the source rewrite for one hit. Returns { splices: [[start, end, text]] } or { error }.
 * `before`/`after` are the edited element's inner HTML before and after editing.
 */
export function plan(hit, text, before, after, rel) {
  const z = hit.zone;
  if (z.kind === 'html') {
    const b = balance(text, z.map[hit.a][0], z.map[hit.b - 1][1]);
    if (!b) return { error: `Couldn't line this up with the HTML in ${rel}` };
    return { splices: [[b[0], b[1], after]] };
  }
  const J = segmentsOf(z, hit.a, hit.b);
  const B = htmlSegments(before), A = htmlSegments(after);
  if (A.length !== B.length) return { error: 'Only the words can be changed here: bold, links and line breaks can\'t be saved for this text.' };
  const jb = bounds(J.map((j) => j.s)), bb = bounds(B);
  if (jb[jb.length - 1] !== bb[bb.length - 1]) return { error: `Couldn't line this up with ${rel}` };
  // blocks: runs of source segments and page segments that cover the same characters
  const common = jb.filter((p) => bb.includes(p));
  const splices = [];
  for (let k = 0; k < common.length - 1; k++) {
    const c0 = common[k], c1 = common[k + 1];
    const js = J.filter((_, i) => jb[i] >= c0 && jb[i + 1] <= c1);
    const bi = B.map((_, i) => i).filter((i) => bb[i] >= c0 && bb[i + 1] <= c1);
    const oldText = tidy(bi.map((i) => B[i]).join('')), newText = tidy(bi.map((i) => A[i]).join(''));
    if (oldText === newText) continue;
    if (js.length !== 1) return { error: `This text is split by code in ${rel}. Change it there.` };
    const seg = js[0];
    const p0 = z.piece[seg.x], p1 = z.piece[seg.y - 1];
    const piece = z.pieces[p0];
    if (p0 !== p1 && !(piece && z.pieces[p1] && piece.esc === z.pieces[p1].esc && (piece.esc === 'jsx' || piece.esc === 'markdown'))) {
      return { error: `Couldn't line this up with the code in ${rel}` };
    }
    const start = z.map[seg.x][0], end = z.map[seg.y - 1][1];
    let out = ESC[piece.esc](newText, piece);
    if (out == null) return { error: `This text needs quotes in ${rel}. Change it there.` };
    if (piece.esc === 'markdown' && /(^|\n)[ \t]*([-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?|#{1,6}[ \t]+)?$/.test(text.slice(Math.max(0, start - 40), start)) && /^([#>+-]|\d+[.)])(\s|$)/.test(out)) out = '\\' + out;
    splices.push([start, end, out]);
  }
  return { splices };
}

export function applySplices(text, splices) {
  const sorted = [...splices].sort((x, y) => y[0] - x[0]);
  for (let i = 1; i < sorted.length; i++) if (sorted[i][1] > sorted[i - 1][0]) throw new Error('Overlapping edits');
  let out = text;
  for (const [s, e, t] of sorted) out = out.slice(0, s) + t + out.slice(e);
  return out;
}
