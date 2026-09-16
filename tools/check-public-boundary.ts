#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkImportGraph } from './check-import-graph';
import { runArchitectureContractCheck } from '../tests/architecture/contracts';

type PublicBoundaryViolation = {
  file: string;
  line: number;
  snippet: string;
};

const targets = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const roots = [...new Set(['apps/xi', ...(targets.length === 0 ? ['tools', 'packages', 'tests', 'docs', 'bench'] : targets)])];
const files = collectSourceFiles(roots);

const violations: PublicBoundaryViolation[] = [];
for (const file of files) {
  const sourceText = readFileSync(file, 'utf8');
  const lines = sourceText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] ?? '';
    if (!lineText.includes('export')) {
      continue;
    }
    const chunk = lines.slice(i, Math.min(lines.length, i + 12)).join('\n');
    const anyIndex = firstExportAnyIndex(chunk);
    if (anyIndex >= 0) {
      violations.push({
        file,
        line: i + 1 + countNewlines(chunk.slice(0, anyIndex)),
        snippet: lineText.trim(),
      });
      break;
    }
  }
}

if (violations.length > 0) {
  console.error(`Found ${violations.length} exported-boundary explicit-any violations:`);
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.snippet}`);
  }
  process.exit(1);
}

console.log('No exported-boundary explicit-any violations found.');

const graphFailures = checkImportGraph(process.cwd());
if (graphFailures.length > 0) {
  console.error(`Architecture import graph failed (${graphFailures.length}):`);
  for (const failure of graphFailures) console.error(failure);
  process.exit(1);
}
console.log('Architecture imports satisfy the public DAG; reverse-import and cycle sentinels rejected as expected.');

await runArchitectureContractCheck();
process.exit(0);

function collectSourceFiles(rawRoots: string[]): string[] {
  const results: string[] = [];
  for (const root of rawRoots) {
    const absoluteRoot = resolve(process.cwd(), root);
    if (!existsSyncFile(absoluteRoot)) {
      continue;
    }
    const stats = statSync(absoluteRoot);
    if (stats.isDirectory()) {
      gatherFiles(absoluteRoot);
    } else if (absoluteRoot.endsWith('.ts')) {
      results.push(absoluteRoot);
    }
  }
  return results;

  function gatherFiles(current: string): void {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.bun-temp') {
        continue;
      }
      const next = resolve(current, entry.name);
      if (entry.isDirectory()) {
        gatherFiles(next);
      } else if (entry.name.endsWith('.ts')) {
        results.push(next);
      }
    }
  }
}

function existsSyncFile(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function countNewlines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  return value.split('\n').length - 1;
}

function firstExportAnyIndex(chunk: string): number {
  const marker = chunk.indexOf('export');
  if (marker < 0) {
    return -1;
  }
  const anyPatterns = [
    /:\s*any\b/,
    /\bas\s+any\b/,
    /<\s*any\s*>/,
    /\bany\[\]/,
  ];
  let earliestIndex = -1;
  for (const pattern of anyPatterns) {
    const match = pattern.exec(chunk.slice(marker));
    if (match && (earliestIndex < 0 || match.index < earliestIndex)) {
      earliestIndex = marker + match.index;
    }
  }
  return earliestIndex;
}
