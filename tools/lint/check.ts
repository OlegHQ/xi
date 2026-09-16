import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseSync } from 'oxc-parser';

// Independent of Oxlint suppressions, so a disable cannot disable its own audit.
export function directiveFailures(text: string, file: string): string[] {
  const parsed = parseSync(file, text);
  const failures: string[] = parsed.errors.map(error => `${file}: ${error.message}`);
  for (const comment of parsed.comments) {
    if (/\b(?:oxlint|eslint)-(?:disable|enable)\b/.test(comment.value)) {
      failures.push(`${file}: Native lint suppression is forbidden; use @xi-perf-allow CODE BUDGET-ID -- concrete reason.`);
    }
  }
  return failures;
}

async function filesAt(path: string): Promise<string[]> {
  if (/\.[cm]?[jt]sx?$/.test(path)) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (['node_modules', '.git', '.artifacts'].includes(entry.name)) continue;
    const next = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesAt(next));
    else if (/\.[cm]?[jt]sx?$/.test(next)) files.push(next);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const targets = process.argv.slice(2);
  const files = (await Promise.all((targets.length ? targets : ['packages', 'apps']).map(filesAt))).flat();
  if (!files.length) throw new Error('No production files found for lint.');
  const failures = (await Promise.all(files.map(async file => directiveFailures(await readFile(file, 'utf8'), file)))).flat();
  if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
  const child = spawn(resolve('node_modules/.bin/oxlint'), ['--config', '.oxlintrc.json', '--disable-nested-config', '--deny-warnings', ...files], { stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
}
