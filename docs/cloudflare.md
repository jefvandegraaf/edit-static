# EditStatic on Cloudflare Pages

EditStatic runs as Pages Functions middleware on your **preview** deployments,
and only on the one hostname you choose. Production gets the same file but no
settings, so it does nothing.

## 1. Add the files

On your `staging` branch:

```bash
npx github:jefvandegraaf/edit-static init --host cloudflare --branch staging
git add functions/_middleware.js .github/workflows/editstatic.yml editstatic.config.json
git commit -m "Add EditStatic"
git push
```

If you already have a `functions/_middleware.js`, init stops rather than
overwriting it. Cloudflare allows one middleware per folder: rename yours and
call it from a small wrapper, or open an issue.

If your build produces its own `_worker.js` (some server-rendered frameworks
do), Pages ignores the `functions` folder. Use Netlify for those sites.

## 2. Add the settings

**Workers & Pages > your project > Settings > Variables and Secrets**. Choose
the **Preview** environment, not Production. Preview settings apply to every
preview branch, which is why `EDIT_HOST` matters: it limits the editor to your
staging alias.

| Name | Value | Type |
| --- | --- | --- |
| `EDIT_PASSWORD` | a long password you choose | Secret |
| `GITHUB_TOKEN` | fine-grained token: only this repo, Contents read and write | Secret |
| `GITHUB_REPO` | `you/your-site` | Text |
| `GITHUB_BRANCH` | `staging` | Text |
| `EDIT_HOST` | `staging.<your-project>.pages.dev` | Text |

The branch alias is the branch name, lowercased, with other characters turned
into `-`: `staging` becomes `staging.<project>.pages.dev`.

## 3. Let the Action push

GitHub repo **Settings > Actions > General > Workflow permissions > Read and
write permissions > Save**.

## 4. Redeploy and open

In **Deployments**, retry the latest `staging` deployment (settings apply to
new deployments). Then:

- `https://staging.<project>.pages.dev/__es/api/health` should say `"ready": true`.
- `https://staging.<project>.pages.dev/?edit` asks for the password.

## Notes

- A save first commits a small file to `.editstatic/pending/`. That commit
  message starts with `[CF-Pages-Skip]`, so it doesn't start a build. The
  Action's commit with your edit does.
- Single-page apps work without extra rules: Pages serves `index.html` for
  unknown paths when there's no `404.html`.
- Updating: run `init` again with a newer version and commit the changed file.
