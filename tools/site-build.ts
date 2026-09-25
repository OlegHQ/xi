#!/usr/bin/env bun
/** Render the checked-in Xi guides and contracts as a versioned static Pages site. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { marked } from 'marked';

const root = resolve(import.meta.dir, '..');
const output = join(root, 'dist', 'site');
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const pages = new Map<string, string>([
  ['index.html', 'site/pages/index.md'],
  ['getting-started.html', 'site/pages/getting-started.md'],
  ['languages.html', 'site/pages/languages.md'],
  ['themes.html', 'site/pages/themes.md'],
  ['keys.html', 'site/pages/keys.md'],
  ['releases.html', 'site/pages/releases.md'],
  ['README.html', 'README.md'],
  ['config/default.toml', 'config/default.toml'],
  ['config/languages.toml', 'config/languages.toml'],
]);
for (const entry of readdirSync(join(root, 'docs'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const source = join('docs', entry.parentPath.replace(`${root}/docs`, '').replace(/^\//u, ''), entry.name);
  const target = source.endsWith('.md') ? source.replace(/\.md$/u, '.html') : source;
  pages.set(target, source);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'assets'), { recursive: true });
cpSync(join(root, 'site', 'style.css'), join(output, 'assets', 'style.css'));
for (const [target, source] of pages) {
  const sourcePath = join(root, source);
  const targetPath = join(output, target);
  mkdirSync(dirname(targetPath), { recursive: true });
  if (!source.endsWith('.md')) { cpSync(sourcePath, targetPath); continue; }
  const markdown = readFileSync(sourcePath, 'utf8').replaceAll('{VERSION}', version).replace(/\]\(([^)#]+)\.md(#[^)]*)?\)/gu, ']($1.html$2)');
  const body = await marked.parse(markdown);
  const title = /^#\s+(.+)$/mu.exec(markdown)?.[1] ?? 'Xi';
  const prefix = '../'.repeat(relative(output, dirname(targetPath)).split('/').filter(part => part && part !== '.').length);
  const nav = [
    ['index.html', 'Home'], ['getting-started.html', 'Start'], ['languages.html', 'Languages'],
    ['themes.html', 'Themes'], ['keys.html', 'Keys'], ['docs/configuration.html', 'Configuration'],
    ['docs/vim.html', 'Vim'], ['releases.html', 'Releases'],
  ].map(([href, label]) => `<a href="${prefix}${href}"${href === target ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  writeFileSync(targetPath, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Xi terminal editor documentation"><title>${escapeHtml(title)} · Xi ${version}</title><link rel="stylesheet" href="${prefix}assets/style.css"></head><body><a class="skip" href="#content">Skip to content</a><header><div class="top"><a class="brand" href="${prefix}index.html">xi<span class="cursor">▌</span></a><nav aria-label="Main navigation">${nav}</nav><span class="version">v${version}</span></div></header><main id="content">${body}</main><footer><span>Xi ${version}</span><a href="https://github.com/OlegHQ/xi">Source</a><a href="${prefix}docs/installation/THIRD-PARTY-NOTICES.html">Licenses</a></footer></body></html>\n`);
}
writeFileSync(join(output, '.nojekyll'), '');

const missing: string[] = [];
for (const target of pages.keys()) {
  if (!target.endsWith('.html')) continue;
  const html = readFileSync(join(output, target), 'utf8');
  for (const match of html.matchAll(/href="([^"]+)"/gu)) {
    const href = match[1]!;
    if (/^(?:https?:|mailto:|#)/u.test(href)) continue;
    const local = href.split(/[?#]/u, 1)[0]!;
    const resolved = resolve(output, dirname(target), decodeURIComponent(local));
    if (!resolved.startsWith(`${output}/`) || !existsSync(resolved)) missing.push(`${target}: ${href}`);
  }
}
if (missing.length > 0) throw new Error(`site has broken local links:\n${missing.join('\n')}`);
console.log(`Built Xi ${version} site: ${pages.size} pages/assets; local links valid`);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
