// Finds the parts of an HTML file a client can edit, with exact source offsets.
//
// A text region is the outermost element that has its own text and holds only
// inline markup (<p>Hello <a>there</a></p>, <a class="btn">Call us</a>). A <nav>
// full of links is not a region; each link inside it is. Every <img> is an image
// region. Ids are the order regions appear in the file, so the same file always
// gives the same ids: the editor page and the save request agree without storing
// anything.
//
// Authors can steer detection on any element:
//   data-edit        always a text region (its whole inside is replaced on save)
//   data-edit="off"  never edit anything inside this element
import { parse } from 'parse5';

// Inline tags a text region may contain.
export const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
  'ins', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u',
  'var', 'wbr',
]);

// Never look inside these.
const SKIP = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object',
  'textarea', 'select', 'option', 'canvas', 'video', 'audio', 'pre',
]);

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const hasOwnText = node =>
  node.childNodes.some(c => c.nodeName === '#text' && c.value.trim() !== '');

function inlineOnly(node) {
  return node.childNodes.every(c => {
    if (c.nodeName === '#text' || c.nodeName === '#comment') return true;
    if (!INLINE.has(c.nodeName)) return false;
    return inlineOnly(c);
  });
}

// Where to insert a new attribute in an element's start tag (before ">" or "/>").
function attrInsertAt(html, loc) {
  const end = loc.startTag.endOffset;
  return html[end - 2] === '/' ? end - 2 : end - 1;
}

/**
 * @returns {{regions: Array<object>, doc: object}}
 * Text region:  { id, kind: 'text', tag, insertAt, innerStart, innerEnd }
 * Image region: { id, kind: 'image', insertAt, attrs: {name: [start, end]}, sources: [[start, end]] }
 */
export function findRegions(html) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const regions = [];

  const walk = node => {
    for (const child of node.childNodes || []) visit(child, node);
  };

  const visit = (node, parent) => {
    if (!node.tagName) return;
    const loc = node.sourceCodeLocation;
    if (SKIP.has(node.tagName)) return;
    const edit = attr(node, 'data-edit');
    if (edit === 'off') return;

    if (node.tagName === 'img') {
      if (!loc?.startTag) return;
      const attrs = {};
      for (const [name, l] of Object.entries(loc.attrs || {})) attrs[name] = [l.startOffset, l.endOffset];
      // A <picture> serves its <source> files ahead of the <img>, so replacing the
      // image has to drop them too.
      const sources = parent?.tagName === 'picture'
        ? parent.childNodes
            .filter(c => c.tagName === 'source' && c.sourceCodeLocation)
            .map(c => [c.sourceCodeLocation.startOffset, c.sourceCodeLocation.endOffset])
        : [];
      regions.push({
        id: regions.length, kind: 'image', insertAt: attrInsertAt(html, loc),
        src: attr(node, 'src') || '', alt: attr(node, 'alt') ?? null, attrs, sources,
      });
      return;
    }

    // An element with no closing tag in the source (an implied </li>) can't be
    // spliced safely, and neither can anything inside it.
    if (!loc?.startTag || !loc.endTag) return;

    const forced = edit !== undefined;
    if (forced || (hasOwnText(node) && inlineOnly(node))) {
      regions.push({
        id: regions.length, kind: 'text', tag: node.tagName,
        insertAt: attrInsertAt(html, loc),
        innerStart: loc.startTag.endOffset, innerEnd: loc.endTag.startOffset,
      });
      return;
    }
    walk(node);
  };

  walk(doc);
  return { regions, doc };
}
