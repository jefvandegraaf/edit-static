// Applies the edits the editing deployment queued in .editstatic/pending/<id>.json
// ({ id, page, changes: [{ before, after }] }). Each job's outcome goes to
// .editstatic/results/<id>.json (the editor polls it to say "Published" or why a line wasn't saved)
// and the job file is removed. If editstatic.config.json has a "build" command (for sites that
// commit their built files), it runs once afterwards. Run by the GitHub Action: `editstatic apply`.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createSync, loadConfig } from './index.js';
import { visible } from './zones.js';

export async function processQueue(root, { build = true, log = console.log } = {}) {
  const pending = path.join(root, '.editstatic', 'pending');
  const results = path.join(root, '.editstatic', 'results');
  const jobs = fs.existsSync(pending) ? fs.readdirSync(pending).filter((f) => f.endsWith('.json')).sort() : [];
  if (!jobs.length) { log('No queued edits.'); return { jobs: 0, applied: 0 }; }
  const cfg = loadConfig(root);
  const { sync } = createSync(root, cfg);
  fs.mkdirSync(results, { recursive: true });
  let applied = 0;
  for (const f of jobs) {
    const job = JSON.parse(fs.readFileSync(path.join(pending, f), 'utf8'));
    const changes = Array.isArray(job.changes) ? job.changes.filter((c) => typeof c.before === 'string' && typeof c.after === 'string') : [];
    const res = await sync({ page: typeof job.page === 'string' ? job.page : '/', changes });
    const ok = res.filter((r) => r.ok);
    applied += ok.filter((r) => r.file !== '(no change)').length;
    const id = String(job.id || f.replace(/\.json$/, '')).replace(/[^\w-]/g, '');
    const out = {
      id, page: job.page, done: true, at: new Date().toISOString(),
      applied: ok.length, files: [...new Set(ok.map((r) => r.file).filter((x) => x !== '(no change)'))],
      errors: res.map((r, i) => (r.ok ? null : { index: i, text: visible(changes[i].before).slice(0, 80), error: r.error })).filter(Boolean),
    };
    fs.writeFileSync(path.join(results, id + '.json'), JSON.stringify(out, null, 2) + '\n');
    fs.rmSync(path.join(pending, f));
    log(`${job.page}: ${ok.length} applied${out.errors.length ? `, ${out.errors.length} refused (${out.errors.map((e) => e.error).join('; ')})` : ''}`);
  }
  // keep the last 50 results; the editor only needs the recent ones
  const done = fs.readdirSync(results).filter((f) => f.endsWith('.json')).sort();
  for (const f of done.slice(0, Math.max(0, done.length - 50))) fs.rmSync(path.join(results, f));
  if (applied && build && cfg.build) {
    log(`Building: ${cfg.build}`);
    execSync(cfg.build, { cwd: root, stdio: 'inherit' });
  }
  return { jobs: jobs.length, applied };
}
