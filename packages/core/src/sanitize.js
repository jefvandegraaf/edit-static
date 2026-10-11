// Cleans what the browser sends back from an edited region before it goes into
// a file. Only inline formatting survives: no scripts, no event handlers, no
// inline styles, no javascript: links. Block elements a browser may add while
// editing (<div>, <p>) are unwrapped into <br> line breaks.
import { parseFragment } from 'parse5';
import { INLINE } from './regions.js';

const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'link', 'meta']);
const BLOCK = new Set(['div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article']);

const ALLOWED_ATTRS = {
  '*': ['class', 'title', 'lang', 'dir'],
  a: ['href', 'target', 'rel'],
  time: ['datetime'],
  data: ['value'],
  abbr: ['title'],
};

const VOID = new Set(['br', 'wbr']);

export const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
export const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function safeUrl(url) {
  // Strip control characters and whitespace browsers ignore, then refuse script schemes.
  const probe = String(url).replace(/[\u0000- \u007f]/g, '').toLowerCase();
  return !/^(javascript|vbscript|data):/.test(probe);
}

function serialize(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.nodeName === '#text') { out += escText(node.value); continue; }
    if (!node.tagName) continue; // comments, doctypes
    const tag = node.tagName;
    if (DROP.has(tag)) continue;
    if (BLOCK.has(tag)) {
      const inner = serialize(node.childNodes);
      if (out && !out.endsWith('<br>') && inner) out += '<br>';
      out += inner;
      continue;
    }
    if (!INLINE.has(tag)) { out += serialize(node.childNodes); continue; }

    const allowed = [...ALLOWED_ATTRS['*'], ...(ALLOWED_ATTRS[tag] || [])];
    let attrs = '';
    for (const { name, value } of node.attrs) {
      if (!allowed.includes(name)) continue;
      if (name === 'href' && !safeUrl(value)) continue;
      attrs += ` ${name}="${escAttr(value)}"`;
    }
    if (VOID.has(tag)) { out += `<${tag}${attrs}>`; continue; }
    out += `<${tag}${attrs}>${serialize(node.childNodes)}</${tag}>`;
  }
  return out;
}

// Browsers type a non-breaking space whenever a plain one would collapse (at a
// line end, next to another space). Those become plain spaces. A non-breaking
// space between two words is kept: that's deliberate glue against one-word lines.
function tidySpaces(html) {
  let prev;
  do {
    prev = html;
    html = html.replace(/&nbsp;(?= )|(?<= )&nbsp;|^&nbsp;|&nbsp;$/g, ' ');
  } while (html !== prev);
  return html.replace(/(?<=\S) {2,}/g, ' ').replace(/^ +| +$/g, '');
}

export function sanitizeInline(html) {
  return tidySpaces(serialize(parseFragment(String(html)).childNodes)
    // A browser leaves a lone <br> in an emptied field.
    .replace(/^(<br>)+$/, ''));
}
