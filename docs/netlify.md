# EditStatic on Netlify

EditStatic runs as a Netlify Edge Function on a **branch deploy** of your site.
Your production deploy gets the same file, but without the settings it does
nothing.

## 1. Add the files

On your `staging` branch:

```bash
npx github:jefvandegraaf/edit-static init --host netlify --branch staging
git add netlify/edge-functions/editstatic.js .github/workflows/editstatic.yml editstatic.config.json
git commit -m "Add EditStatic"
git push
```

If your site sets a different edge functions folder in `netlify.toml`, move the
file there.

## 2. Turn on the staging branch deploy

**Project configuration > Build & deploy > Continuous deployment > Branches and
deploy contexts > Branch deploys > Let me add individual branches**: add `staging`.
It will be served at `https://staging--<your-site>.netlify.app`.

## 3. Add the settings

**Project configuration > Environment variables > Add a variable**. For each one
choose **Different value for each deploy context** and fill in only **Branch
deploys** (or a value for the `staging` branch). Leave Production empty. If your
plan shows scopes, include **Functions**: edge functions only see variables with
that scope. Variables written in `netlify.toml` are not visible to functions,
so use the dashboard.

| Name | Value |
| --- | --- |
| `EDIT_PASSWORD` | a long password you choose |
| `GITHUB_TOKEN` | fine-grained token: only this repo, Contents read and write |
| `GITHUB_REPO` | `you/your-site` |
| `GITHUB_BRANCH` | `staging` |
| `EDIT_HOST` | `staging--<your-site>.netlify.app` |

## 4. Let the Action push

GitHub repo **Settings > Actions > General > Workflow permissions > Read and
write permissions > Save**.

## 5. Redeploy and open

Trigger a new deploy of `staging` (settings apply to new deploys). Then:

- `https://staging--<your-site>.netlify.app/__es/api/health` should say `"ready": true`.
- `https://staging--<your-site>.netlify.app/?edit` asks for the password.

## Notes

- A save first commits a small file to `.editstatic/pending/`. That commit's
  message includes `[skip netlify]`, so it doesn't start a build. The Action's
  commit with your edit does.
- Single-page apps need the usual `/*  /index.html  200` rule in
  `public/_redirects`. The edge function runs before it.
- Updating: run `init` again with a newer version and commit the changed files.
