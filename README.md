# EditStatic

Click-to-edit for plain HTML sites. Clients edit text and images on the real
page; saves rewrite only what changed, so the rest of the file stays exactly as
built. Product site: editstatic.site.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Finds editable regions with exact source offsets, applies edits as splices, cleans edited HTML. Runs in Node and Cloudflare Workers. |
| `packages/editor/editor.js` | The in-page editor (bar, click-to-edit, images, Save all / Discard). Same file for every host. |
| `apps/local` | Local server: serves a site folder with the editor on and writes saves into the files. The engine the desktop app will wrap. |
| `fixtures/sample-site` | Test site. Reset after testing with `git checkout -- fixtures/`. |

Planned: `apps/web` (live version at app.editstatic.site: email-code sign-in,
saves commit to the site's GitHub repo, Cloudflare Pages deploys) and
`apps/desktop` (Electron wrapper around `apps/local`).

## Run

```
npm install
npm test
node apps/local/server.js <site-folder> --port 8450
```

## What counts as editable

- **Text:** the outermost element with its own text that holds only inline
  markup. `<p>Hi <a>there</a></p>` is one region; a `<nav>` of links is one
  region per link.
- **Images:** every `<img>`. Replacing one resizes it to at most 2400px wide,
  strips camera and GPS data, drops `srcset` and `<picture>` sources, and updates
  `width`/`height`.
- `data-edit` on an element makes its whole inside one text region;
  `data-edit="off"` locks everything inside.
- Skipped: `<head>`, scripts, styles, SVG, forms fields, `<pre>`, and elements
  without a closing tag in the source.

## Saving

- Edited HTML keeps inline formatting only (bold, italic, links, line breaks);
  scripts, event handlers, inline styles and `javascript:` links are removed.
- Every save carries the page's version hash. If the file changed since the
  page opened, the save is refused (409) instead of overwriting.
- The local API only accepts requests from its own page (Host, Origin and an
  `X-EditStatic` header are checked) and listens on 127.0.0.1 only.
