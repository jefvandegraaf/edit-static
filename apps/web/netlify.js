// Netlify Edge Function entry: built to <site>/netlify/edge-functions/editstatic.js.
// Settings are environment variables with the Functions scope, set for the Branch deploys
// context (or one branch) only, never Production.
import { createHandler } from './handler.js';

/* global __ES_CLIENT__, __ES_EDITOR__, Netlify */
const handle = createHandler({
  client: typeof __ES_CLIENT__ !== 'undefined' ? __ES_CLIENT__ : '',
  editor: typeof __ES_EDITOR__ !== 'undefined' ? __ES_EDITOR__ : '',
  // Netlify skips the build for a commit with this in its message; the queued save is applied by
  // the GitHub Action, whose commit then deploys once
  message: (m) => `${m} [skip netlify]`,
});
const NAMES = ['EDIT_PASSWORD', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH', 'EDIT_HOST', 'EDIT_MODE'];

export default (request, context) => handle(request, {
  env: Object.fromEntries(NAMES.map((n) => [n, Netlify.env.get(n)])),
  next: () => context.next(),
  // goes through this function again; the header makes it pass straight through
  fetchAsset: (path, origin) => fetch(new URL(path, origin), { headers: { 'x-editstatic-raw': '1' } }),
});

export const config = {
  path: '/*',
  excludedPath: ['/assets/*', '/_next/*', '/*.js', '/*.css', '/*.map', '/*.png', '/*.jpg', '/*.jpeg', '/*.webp', '/*.avif', '/*.gif', '/*.svg', '/*.ico', '/*.woff', '/*.woff2', '/*.mp4', '/*.pdf'],
};
