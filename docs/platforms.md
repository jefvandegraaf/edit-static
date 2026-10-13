# Which sites EditStatic works with

EditStatic needs three things:

1. the site's code in a **GitHub repo**,
2. a deployment on **Netlify** or **Cloudflare Pages** that builds from a branch
   you can use for editing (usually `staging`),
3. the text in **files** (components, Markdown, JSON), not in a database.

If your tool gives you a GitHub repo, you can host that repo on Netlify or
Cloudflare Pages yourself, even if the tool also hosts it for you. Your tool's
own hosting stays as it is.

Last checked: October 2026. These tools change fast; corrections welcome.

| Built with | What it makes | Works? | How |
| --- | --- | --- | --- |
| Claude Code, Cursor, Codex, Windsurf | Whatever you ask for: plain HTML, Astro, Eleventy, Vite + React... | Yes | Push the repo to GitHub, deploy it on Netlify or Cloudflare Pages. The easiest case. |
| Lovable, projects before May 2026 | React + Vite + TypeScript + Tailwind, a single-page app | Yes | GitHub sync, then deploy the repo on Netlify or Cloudflare Pages. See below. |
| Lovable, projects since May 2026 | TanStack Start with server rendering | Netlify: should work, not yet tested. Cloudflare Pages: no | Netlify edge functions run in front of server-rendered pages too. On Cloudflare Pages the build ships its own `_worker.js`, which switches Pages Functions off. |
| Bolt.new | Usually React + Vite | Yes | Connect GitHub in Bolt, then deploy the repo on your own Netlify (or Cloudflare) site. |
| Replit Agent | Usually React + Vite, often with an Express server | Front-end only sites: yes | Push to GitHub. A static build can go on Netlify or Cloudflare Pages; a site that needs Replit's server can't. |
| v0 (Vercel) | Next.js | Not yet | Needs a Vercel adapter. Next.js middleware can't add a script to pages, so this needs a different approach. Help welcome. |
| Base44, Google AI Studio | Apps tied to their own backend | Usually no | The text often lives in the app's database or depends on their server. |
| Hand-written HTML, Hugo, Jekyll, Eleventy, Astro | Static pages | Yes | Plain HTML pages even accept formatting changes (bold, links, line breaks). |

## Lovable

Lovable has **Visual Edits** built in: in the preview toolbar you can click
text and change it without a prompt. If you're the only editor and you work in
Lovable anyway, use that.

EditStatic helps when:

- someone else should fix copy (a client, a colleague, a copywriter) without
  getting into your Lovable project or spending its credits,
- you want to proofread on the real site, on your phone, the way visitors see it,
- you edit a lot of copy at once.

Setup:

1. In Lovable, connect GitHub. Lovable syncs both ways with **one branch**,
   your default branch unless you pick another.
2. Deploy the repo on Netlify (or Cloudflare Pages, for older projects). Lovable's
   docs list the settings: build `npm run build`, output `dist`, Node 22, and a
   `public/_redirects` file containing `/*  /index.html  200` for single-page apps.
3. Choose where edits go:
   - **A `staging` branch** (safest): EditStatic commits there, you merge into
     main when you're happy, and Lovable picks it up from main.
   - **The branch Lovable syncs**: edits show up in Lovable right away. Set
     `GITHUB_BRANCH` to that branch and `EDIT_HOST` to the deployment URL you
     edit on (for example the `*.netlify.app` address, not your custom domain),
     so visitors on your domain never see an editor.
4. Run `npx github:jefvandegraaf/edit-static init --host netlify --branch staging`
   in the repo and follow the steps it prints.

Don't edit in Lovable and EditStatic at the same moment: if both push to the
same branch at once, one side's change can be replaced (Lovable keeps a backup).

## Bolt.new

Bolt publishes to its own hosting by default. Connect GitHub in Bolt, then
create your own Netlify site from that repo for editing. Bolt checks GitHub
about every 30 seconds and pulls outside changes in, so merged edits appear in
Bolt. As with Lovable, avoid editing in both places at the same moment.

## Claude Code, Cursor, Codex

You already have the repo. Ask your tool to deploy it on Netlify or Cloudflare
Pages with a `staging` branch deploy, run `init`, and you're done. A tip for
your prompt: ask for copy to live in plain strings, Markdown or JSON rather than
assembled from variables. Whatever is a plain sentence in a file can be edited.

## Something else

Run `npx github:jefvandegraaf/edit-static find "a sentence from your site"` in
the repo. If it says "Would be saved to ...", the source side works. Then all
you need is a Netlify or Cloudflare Pages deployment.
