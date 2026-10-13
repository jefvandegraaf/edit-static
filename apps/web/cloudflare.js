// Cloudflare Pages Functions entry: built to <site>/functions/_middleware.js.
// Settings go on the Preview environment (Settings > Variables and Secrets), never Production.
import { createHandler } from './handler.js';

/* global __ES_CLIENT__, __ES_EDITOR__ */
const handle = createHandler({
  client: typeof __ES_CLIENT__ !== 'undefined' ? __ES_CLIENT__ : '',
  editor: typeof __ES_EDITOR__ !== 'undefined' ? __ES_EDITOR__ : '',
  // Cloudflare skips a Pages build when the commit message starts with this; the queued save
  // is applied by the GitHub Action, whose commit then deploys once
  message: (m) => `[CF-Pages-Skip] ${m}`,
});

export function onRequest(ctx) {
  return handle(ctx.request, {
    env: ctx.env,
    next: () => ctx.next(),
    fetchAsset: (path, origin) => ctx.env.ASSETS.fetch(new URL(path, origin)),
  });
}
