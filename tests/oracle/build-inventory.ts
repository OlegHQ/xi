#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { projectRoot, verifyOracleBundle } from './oracle-runner';
import type { OracleIndexEntry, OracleMode } from './types';

const { manifest, runtimePath } = await verifyOracleBundle();
const indexPath = join(runtimePath, 'doc', 'index.txt');
const indexText = await readFile(indexPath, 'utf8');
const indexHash = manifest.oracle.runtimeDocs.criticalFiles['index.txt'];
if (indexHash === undefined) throw new Error('pinned-oracle-manifest-missing-index-hash');

const entries = parseIndex(indexText);
if (entries.length < 500) throw new Error(`neovim-command-index-parse-suspicious: only ${entries.length} entries`);
const entryIds = new Set(entries.map((entry) => entry.id));
if (entryIds.size !== entries.length) throw new Error('neovim-command-index-duplicate-inventory-id');
if (entries.some((entry) => !entry.helpTag || !entry.key || entry.modes.length === 0 || entry.status !== 'unimplemented' || entry.optionMatrix.review !== 'unexpanded' || entry.dependencyReview !== 'seed-unverified')) {
  throw new Error('neovim-command-index-row-missing-required-inventory-field');
}
const planDocument: unknown = JSON.parse(await readFile(resolve(projectRoot, 'docs/plan/tickets.json'), 'utf8'));
if (!isRecord(planDocument) || !Array.isArray(planDocument.tickets)) throw new Error('invalid-ticket-plan-for-vim-inventory');
const plannedTickets = new Set(planDocument.tickets.filter(isRecord).map((ticket) => ticket.id).filter((id): id is string => typeof id === 'string'));
const unknownTickets = entries.map((entry) => entry.implementingTicket).filter((ticket) => !plannedTickets.has(ticket));
if (unknownTickets.length > 0) throw new Error(`inventory-implementation-ticket-missing-from-plan: ${[...new Set(unknownTickets)].join(', ')}`);

const output = {
  schemaVersion: 1,
  source: {
    name: manifest.oracle.name,
    version: manifest.oracle.version,
    releaseTag: manifest.oracle.tag,
    binarySha256: manifest.oracle.binarySha256,
    runtimeDocsSha256: manifest.oracle.runtimeDocs.sha256,
    indexPath: 'runtime/doc/index.txt',
    indexSha256: indexHash,
    generatedFrom: [
      '1. Insert mode',
      '2. Normal mode',
      '2.6 Operator-pending mode',
      '3. Visual mode',
    ],
  },
  policy: {
    status: 'unimplemented' as const,
    optionMatrix: 'Candidate options are listed per owner ticket. This inventory is a help-index seed, not a parity claim.',
    dependencies: 'Dependency candidates are heuristic and marked for review; unverified behavior stays unimplemented.',
    completenessAudit: 'T061 must reconcile all rows against the pinned normal, visual, operator-pending and insert indexes.',
  },
  counts: {
    total: entries.length,
    entriesByMode: Object.fromEntries((['insert', 'normal', 'operator-pending', 'visual'] as const).map((mode) => [
      mode,
      entries.filter((entry) => entry.modes.includes(mode)).length,
    ])),
    allUnimplemented: entries.every((entry) => entry.status === 'unimplemented'),
  },
  entries,
};

const outputPath = resolve(projectRoot, 'docs/compatibility/neovim-0.12.4.json');
await mkdir(resolve(projectRoot, 'docs/compatibility'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`inventory=${outputPath}`);
console.log(`source=${manifest.oracle.name} ${manifest.oracle.version} binary=${manifest.oracle.binarySha256}`);
console.log(`runtime_docs=${manifest.oracle.runtimeDocs.sha256} index=${indexHash}`);
console.log(`entries=${entries.length} by_mode=${JSON.stringify(output.counts.entriesByMode)} all_unimplemented=${output.counts.allUnimplemented}`);

function parseIndex(source: string): OracleIndexEntry[] {
  const outputEntries: OracleIndexEntry[] = [];
  let modes: OracleMode[] | undefined;
  for (const line of source.split(/\r?\n/u)) {
    const heading = line.match(/^\s*\d+(?:\.\d+)?\.?\s+(Insert|Normal|Operator-pending|Visual) mode\b/u);
    if (heading?.[1] !== undefined) {
      const mode = heading[1] === 'Insert'
        ? 'insert'
        : heading[1] === 'Normal'
          ? 'normal'
          : heading[1] === 'Visual'
            ? 'visual'
            : 'operator-pending';
      modes = [mode];
      continue;
    }
    if (/^\s*2\.\d+\s+(?!Text objects\b)/u.test(line)) {
      modes = ['normal'];
      continue;
    }
    if (/These can be used after an operator or in Visual mode to select an object/u.test(line)) {
      modes = ['operator-pending', 'visual'];
      continue;
    }
    if (/^\s*\d+\. Command-line editing\b/u.test(line) || /^\s*\d+\. Ex commands\b/u.test(line)) {
      modes = undefined;
      continue;
    }
    if (modes === undefined || modes.length === 0) continue;
    const match = line.match(/^\|([^|]+)\|\s+(.+?)\s{2,}(.+?)\s*$/u);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    const helpTag = match[1].trim();
    const key = match[2].trim();
    const description = match[3].trim().replace(/\s+~/u, '');
    if (helpTag.length === 0 || key.length === 0 || description.length === 0) continue;
    const index = outputEntries.length + 1;
    const representativeMode = modes.includes('operator-pending') ? 'operator-pending' : modes[0];
    if (representativeMode === undefined) continue;
    const optionNames = optionCandidates(representativeMode, key, description);
    const idMode = modes.length > 1 ? 'OBJECT' : representativeMode.toUpperCase().replaceAll('-', '');
    outputEntries.push({
      id: `NVI-${idMode}-${String(index).padStart(4, '0')}`,
      key,
      helpTag,
      description,
      modes: [...modes],
      options: optionNames,
      optionMatrix: {
        profile: 'strict',
        baseline: 'pinned-defaults',
        candidateOptions: optionNames,
        review: 'unexpanded',
      },
      dependencies: dependencyCandidates(key, helpTag, description),
      dependencyReview: 'seed-unverified',
      fixtureIds: fixtureIds(representativeMode, key),
      implementingTicket: implementingTicket(representativeMode, key, helpTag, description),
      status: 'unimplemented',
    });
  }
  return outputEntries;
}

function implementingTicket(mode: OracleMode, key: string, helpTag: string, description: string): string {
  const bareKey = key.trim();
  // The index uses command notation such as `["x]C` and `N<Del>` for
  // register/count forms.  Normalize those aliases before applying the
  // family routing rules below; otherwise implemented direct commands are
  // incorrectly left as T061 audit rows.
  const normalizedHelpTag = helpTag.trim();
  if (mode === 'normal') {
    if (['C', 'D', 'S', 'X', 'cc', 'dd', 'r', 'x', '<Del>', 'N<Del>', '~'].includes(normalizedHelpTag)
      || normalizedHelpTag === 'C' || normalizedHelpTag === 'D' || normalizedHelpTag === 'S' || normalizedHelpTag === 'X') return 'T032';
    if (normalizedHelpTag === 'g?' || normalizedHelpTag === 'g?g?') return 'T103';
    if (bareKey === '!!{filter}' || normalizedHelpTag === '!!') return 'T104';
    if (bareKey === '<<' || bareKey === '>>' || normalizedHelpTag === '<<' || normalizedHelpTag === '>>') return 'T103';
    if (bareKey === 'ZZ' || bareKey === 'ZQ' || normalizedHelpTag === 'ZZ' || normalizedHelpTag === 'ZQ') return 'T028';
    if (normalizedHelpTag === 'g&') return 'T027';
    if (normalizedHelpTag === "g'" || normalizedHelpTag === 'g`') return 'T030';
    if (normalizedHelpTag === 'g+' || normalizedHelpTag === 'g-') return 'T012';
    if (normalizedHelpTag === 'gD' || normalizedHelpTag === 'gd') return 'T071';
    if (normalizedHelpTag === 'gH' || normalizedHelpTag === 'gh') return 'T021';
    if (normalizedHelpTag === 'gN' || normalizedHelpTag === 'gn') return 'T027';
    if (normalizedHelpTag === 'gQ') return 'T028';
    if (normalizedHelpTag === 'gT' || normalizedHelpTag === 'gt' || normalizedHelpTag === 'g<Tab>' || bareKey === 'CTRL-<Tab>') return 'T038';
    if (normalizedHelpTag === 'z<CR>' || normalizedHelpTag === 'zN<CR>' || normalizedHelpTag === 'z<Left>' || normalizedHelpTag === 'z<Right>') return 'T031';
    if (normalizedHelpTag === 'zp' || normalizedHelpTag === 'zP') return 'T023';
    if (normalizedHelpTag === '[c' || normalizedHelpTag === ']c') return 'T030';
    if (normalizedHelpTag === '[P' || normalizedHelpTag === ']P') return 'T023';
    if (normalizedHelpTag === '[(' || normalizedHelpTag === '[{' || normalizedHelpTag === '])' || normalizedHelpTag === ']}') return 'T029';
    if (normalizedHelpTag === 'go') return 'T016';
    if (normalizedHelpTag === 'gr') return 'T032';
    if (normalizedHelpTag === 'CTRL-\\_CTRL-N' || normalizedHelpTag === 'CTRL-\\_CTRL-G') return 'T013';
    if (normalizedHelpTag === 'g_CTRL-H') return 'T021';
    if (/include|#define|tag stack|tag list|keyword under the cursor|include file/u.test(description)) return 'T071';
  }
  if (mode === 'insert') return 'T022';
  if (mode === 'visual') {
    if (/^v_[ai]/u.test(helpTag)) return 'T020';
    return 'T021';
  }
  if (mode === 'operator-pending') {
    return (bareKey.startsWith('i') || bareKey.startsWith('a')) && bareKey.length > 1 ? 'T020' : 'T019';
  }
  if (/^(?:\d|count)$/u.test(bareKey) || /prepend to command to give a count/u.test(description)) return 'T013';
  if (bareKey.startsWith('CTRL-W ') || bareKey === 'CTRL-W' || /^(?:<C-Tab>|<C-LeftMouse>|<C-RightMouse>)$/u.test(bareKey)) return 'T038';
  if (/mouse|pointer/u.test(description) || /Mouse/u.test(bareKey)) return 'T086';
  if (/fold/u.test(`${bareKey} ${helpTag} ${description}`)) return 'T067';
  if (/^(?:\.|&|~)$/u.test(bareKey)) return bareKey === '.' ? 'T024' : 'T032';
  if (/^(?:q|@|@@|@\{|q\{)/u.test(bareKey)) return 'T025';
  if (bareKey === '"' || bareKey.startsWith('"') || /^(?:p|P|gp|gP)$/u.test(bareKey) || /use \{register\}|put the text|yank/u.test(description)) return 'T023';
  if (/^(?:u|U|CTRL-R|<Undo>)$/u.test(bareKey) || /undo/u.test(description)) return 'T012';
  if ([':', 'Q', 'q:', 'q/', 'q?', '@:', '{count}:'].includes(bareKey) || /Ex command/u.test(description)) return 'T028';
  if (/^(?:CTRL-\]|CTRL-T|K|gf|gF|g<|gF)$/u.test(bareKey) || /tag|include file|keyword under the cursor/u.test(description)) return 'T071';
  if (/^(?:CTRL-B|CTRL-F|CTRL-D|CTRL-U|CTRL-E|CTRL-Y|CTRL-L|<PageDown>|<PageUp>|<S-Down>|<S-Up>)$/u.test(bareKey)) return 'T031';
  if (/^(?:w|W|b|B|e|E|ge|gE)$/u.test(bareKey)) return 'T017';
  if (/^(?:f|F|t|T|;|,)$/u.test(bareKey)) return 'T018';
  if (/^(?:gj|gk|g0|g\^|g\$|gm|gM|CTRL-[EY]|z[btgHMLz.\-+^\$])$/u.test(bareKey) || /scroll|screen row|wrapped line/u.test(description)) return 'T031';
  if (/^(?:\/|\?|n|N|\*|#|g\*|g#)$/u.test(bareKey)) return 'T027';
  if (/^(?:m|['`]|CTRL-[OI]|g[;,]|<Tab>)$/u.test(bareKey) || /mark|jump list|changelist|change list/u.test(description)) return 'T030';
  if (/^(?:v|V|CTRL-V|o|gv|gV)$/u.test(bareKey)) return 'T021';
  if (/^(?:h|l|0|\^|\$|g_|\||\+|-|_|<CR>|<Enter>|<NL>|CTRL-J|CTRL-M|CTRL-N|CTRL-P|CTRL-H|<BS>|<Space>|j|k|gg|G|H|M|L|<Home>|<End>|<Up>|<Down>|<Left>|<Right>|<C-Home>|<C-End>)$/u.test(bareKey)) return 'T016';
  if (/^(?:CTRL-W|<C-Tab>)$/u.test(bareKey)) return 'T038';
  if (/^(?:'|`)/u.test(helpTag)) return 'T030';
  if (/^(?:d|c|y|>|<|=|!|gq|gw|gu|gU|g~|g\?)$/u.test(helpTag)) return helpTag === 'y' ? 'T023' : 'T019';
  if (/^(?:F|T|f|t)$/u.test(helpTag) || /cursor to the Nth occurrence|cursor till/u.test(description)) return 'T018';
  if (/^(?:CTRL-W_)/u.test(helpTag)) return 'T038';
  if (/^CTRL-W/u.test(helpTag) || /window commands/u.test(description)) return 'T038';
  const sameAs = description.match(/same as\s+[`"']?([^`"'\s,:]+)/u)?.[1];
  const aliasOwner = sameAs === undefined ? undefined : aliasTicket(sameAs);
  if (aliasOwner !== undefined) return aliasOwner;
  if (['g', 'z', '[', ']', 'g{char}', 'z{char}'].includes(bareKey) || /extended commands|square bracket command|commands starting with 'z'/u.test(description)) return 'T013';
  if (/^(?:d|c|y|>|<|=|!)$/u.test(bareKey)) return bareKey === 'y' ? 'T023' : 'T019';
  if (['gq', 'gw', 'gu', 'gU', 'g~', 'g?', 'zf', 'zF', 'zD', 'zE', 'g@', '(', ')', '{', '}', '[[', ']]', '[]', '][', '%', '{count}%'].includes(bareKey)) return 'T029';
  if (/^(?:i|I|a|A|o|O|R|gR|gi|gI)$/u.test(bareKey)) return 'T022';
  if (/^(?:x|X|s|S|D|C|r|J|gJ|CTRL-A|CTRL-X|~)$/u.test(bareKey)) return 'T032';
  if (/^(?:CTRL-\^|<C-Tab>)$/u.test(bareKey) || /alternate file/u.test(description)) return 'T038';
  if (/^CTRL-\]/u.test(bareKey) || /tag stack|tag list/u.test(description)) return 'T071';
  if (/format|indent/u.test(description)) return 'T029';
  if (/pattern|search|substitute/u.test(description)) return 'T027';
  if (/cursor|move|motion|line|word/u.test(description)) return 'T061';
  return 'T061';
}

function aliasTicket(alias: string): string | undefined {
  if (['h', 'l', '0', '^', '$', 'g_', '|', '+', '-', '_', '<CR>', '<Enter>', '<NL>', 'j', 'k', 'gg', 'G', 'H', 'M', 'L'].includes(alias)) return 'T016';
  if (['w', 'W', 'b', 'B', 'e', 'E', 'ge', 'gE', '<C-Left>', '<C-Right>'].includes(alias)) return 'T017';
  if (['f', 'F', 't', 'T', ';', ','].includes(alias)) return 'T018';
  if (['gj', 'gk', 'g0', 'g^', 'g$', 'gm', 'gM', 'CTRL-B', 'CTRL-F', 'CTRL-D', 'CTRL-U', 'CTRL-E', 'CTRL-Y', '<PageDown>', '<PageUp>'].includes(alias)) return 'T031';
  if (['d', 'c', '>', '<', '=', '!'].includes(alias)) return 'T019';
  if (['y', 'p', 'P', 'gp', 'gP'].includes(alias)) return 'T023';
  if (['i', 'I', 'a', 'A', 'o', 'O', 'R'].includes(alias)) return 'T022';
  if (['v', 'V', 'CTRL-V', 'o'].includes(alias)) return 'T021';
  if (['u', 'CTRL-R', '<Undo>'].includes(alias)) return 'T012';
  if (['.', '&'].includes(alias)) return alias === '.' ? 'T024' : 'T027';
  if (['m', "'", '`', 'CTRL-O', 'CTRL-I'].includes(alias)) return 'T030';
  if (['/', '?', 'n', 'N', '*', '#', 'g*', 'g#'].includes(alias)) return 'T027';
  if (['q', '@', '@@'].includes(alias)) return 'T025';
  if ([':', 'ZZ', 'ZQ'].includes(alias)) return 'T028';
  return undefined;
}

function optionCandidates(mode: OracleMode, key: string, description: string): string[] {
  const ticket = implementingTicket(mode, key, '', description);
  const candidates: Readonly<Record<string, readonly string[]>> = {
    T016: ['startofline', 'whichwrap', 'scrolloff'],
    T017: ['iskeyword'],
    T018: ['iskeyword', 'cpoptions'],
    T019: ['selection', 'virtualedit', 'cpoptions'],
    T020: ['iskeyword', 'selection', 'virtualedit'],
    T021: ['selection', 'virtualedit'],
    T022: ['backspace', 'expandtab', 'shiftwidth', 'tabstop'],
    T023: ['clipboard'],
    T027: ['ignorecase', 'smartcase', 'wrapscan'],
    T029: ['matchpairs', 'paragraphs', 'sections', 'foldmethod', 'formatprg', 'formatexpr', 'equalprg'],
    T031: ['wrap', 'linebreak', 'scrolloff', 'sidescrolloff', 'startofline'],
    T032: ['nrformats', 'backspace', 'shiftwidth', 'tabstop'],
  };
  return [...(candidates[ticket] ?? [])];
}

function dependencyCandidates(key: string, tag: string, description: string): string[] {
  const value = `${key} ${tag} ${description}`.toLowerCase();
  const result: string[] = [];
  if (/\b(?:fold|zf|zo|zc|z[ao])\b/u.test(value)) result.push('fold-provider-or-fold-state');
  if (/\b(?:tag|tags|ctrl-\])\b/u.test(value)) result.push('tag-provider');
  if (/\b(?:include|includexpr|gf|gF)\b/u.test(value)) result.push('include-provider');
  if (/\b(?:syntax|matchpairs|matchit)\b/u.test(value)) result.push('syntax-or-matchpairs');
  if (/\b(?:formatprg|formatexpr|equalprg|indentexpr)\b/u.test(value)) result.push('format-or-indent-provider');
  return result;
}

function fixtureIds(mode: OracleMode, key: string): string[] {
  const value = key.trim();
  const ids: string[] = [];
  if (mode === 'normal' && value === 'd') ids.push('ORC-RANGE-01');
  if (mode === 'normal' && value === 'l') ids.push('ORC-BYTE-01');
  if (mode === 'normal' && value === 'gj') ids.push('ORC-WRAP-01');
  if (mode === 'insert' && value === '<Esc>') ids.push('ORC-INSERT-01');
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
