// Turning a source file into an editable page, and writing edits back into it.
//
// Every write is a splice at exact source offsets: only the inside of an edited
// region (or one attribute of an edited image) changes. Indentation, comments,
// attribute order and line endings everywhere else stay byte-identical.
import { findRegions } from './regions.js';
import { sanitizeInline, escAttr, safeUrl } from './sanitize.js';

export async function hashText(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function splice(html, splices) {
  const sorted = [...splices].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][1] > sorted[i - 1][0]) throw new Error('Overlapping edits');
  }
  let out = html;
  for (const [start, end, text] of sorted) out = out.slice(0, start) + text + out.slice(end);
  return out;
}

/**
 * The page the editor shows: every region tagged with data-es="<id>", plus
 * `inject` (the editor script) just before </body>.
 */
export function annotate(html, { inject = '' } = {}) {
  const { regions } = findRegions(html);
  const splices = regions.map(r => [r.insertAt, r.insertAt, ` data-es="${r.id}"`]);
  let bodyEnd = html.search(/<\/body\s*>/i);
  if (bodyEnd === -1) bodyEnd = html.length;
  if (inject) splices.push([bodyEnd, bodyEnd, inject]);
  return { html: splice(html, splices), regions };
}

// Removes an attribute together with the whitespace in front of it.
function dropAttr(html, [start, end]) {
  while (start > 0 && /\s/.test(html[start - 1])) start--;
  return [start, end, ''];
}

function setAttr(region, name, value, splices) {
  const text = `${name}="${escAttr(value)}"`;
  const range = region.attrs[name];
  splices.push(range ? [range[0], range[1], text] : [region.insertAt, region.insertAt, ' ' + text]);
}

/**
 * @param {string} html  current file contents
 * @param {Array} edits  { id, html } for text; { id, src?, alt?, width?, height? } for images
 * @returns {{ html: string, applied: number[], errors: Array<{id, error}> }}
 */
export function applyEdits(html, edits) {
  const { regions } = findRegions(html);
  const splices = [];
  const applied = [];
  const errors = [];

  for (const edit of edits) {
    const region = regions[edit.id];
    if (!region) { errors.push({ id: edit.id, error: 'No such region' }); continue; }

    if (region.kind === 'text') {
      if (typeof edit.html !== 'string') { errors.push({ id: edit.id, error: 'Text edit needs html' }); continue; }
      splices.push([region.innerStart, region.innerEnd, sanitizeInline(edit.html)]);
      applied.push(edit.id);
      continue;
    }

    // Image
    const before = splices.length;
    if (edit.src !== undefined) {
      if (!safeUrl(edit.src)) { errors.push({ id: edit.id, error: 'Unsafe image URL' }); continue; }
      setAttr(region, 'src', edit.src, splices);
      // srcset and <picture> sources would keep serving the old file.
      for (const name of ['srcset', 'sizes']) if (region.attrs[name]) splices.push(dropAttr(html, region.attrs[name]));
      for (const range of region.sources) splices.push(dropAttr(html, range));
      for (const name of ['width', 'height']) {
        if (region.attrs[name] && Number.isInteger(edit[name]) && edit[name] > 0) setAttr(region, name, String(edit[name]), splices);
      }
    }
    if (edit.alt !== undefined) setAttr(region, 'alt', String(edit.alt), splices);
    if (splices.length > before) applied.push(edit.id);
  }

  return { html: splices.length ? splice(html, splices) : html, applied, errors };
}
