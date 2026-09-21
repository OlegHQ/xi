#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseToml } from '../packages/services/config/index';

const REQUIRED = ['schema', 'default', 'runtime', 'invalid', 'unit', 'pty', 'helix'] as const;
const REFERENCES = new Set(['stable', 'master', 'xi']);
const STATUSES = new Set(['missing', 'parsed-only', 'incompatible', 'effective']);
const STABLE_COMMIT = 'a05c151bb6e8e9c65ec390b0ae2afe7a5efd619b';
const MASTER_COMMIT = '079a789e8cb08ead67f19e1971a1b7438b37354b';

export function validateConfigLedger(value: unknown, root = process.cwd()): string[] {
  const errors: string[] = [];
  const tracked = new Set(execFileSync('git', ['ls-files', '--cached', '--', 'tests'], { cwd: root, encoding: 'utf8' }).split('\n'));
  if (!record(value)) return ['ledger must be an object'];
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const references = object(value, 'references', errors);
  if (references !== undefined) {
    const stable = object(references, 'stable', errors);
    const master = object(references, 'master', errors);
    if (stable?.commit !== STABLE_COMMIT) errors.push(`stable commit must remain pinned to ${STABLE_COMMIT}`);
    if (master?.commit !== MASTER_COMMIT) errors.push(`master commit must remain pinned to ${MASTER_COMMIT}`);
  }
  const policy = object(value, 'policy', errors);
  const required = policy?.requiredValidation;
  if (!strings(required) || required.join('\0') !== REQUIRED.join('\0')) {
    errors.push(`policy.requiredValidation must be exactly ${REQUIRED.join(', ')}`);
  }
  const sealedHash = typeof policy?.inventorySha256 === 'string' ? policy.inventorySha256 : undefined;
  if (sealedHash === undefined) errors.push('policy.inventorySha256 must seal the audited inventory');

  if (!Array.isArray(value.items) || value.items.length === 0) return [...errors, 'items must be a nonempty array'];
  const ids = new Set<string>();
  const identities: string[] = [];
  const items: Record<string, unknown>[] = [];
  for (const [index, candidate] of value.items.entries()) {
    const at = `items[${index}]`;
    if (!record(candidate)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    items.push(candidate);
    const id = text(candidate.id, `${at}.id`, errors);
    const path = text(candidate.path, `${at}.path`, errors);
    const reference = text(candidate.reference, `${at}.reference`, errors);
    const status = text(candidate.status, `${at}.status`, errors);
    const variant = candidate.variant === undefined ? '' : text(candidate.variant, `${at}.variant`, errors);
    if (!Object.hasOwn(candidate, 'default')) errors.push(`${at}.default is required`);
    if (id !== undefined) {
      if (ids.has(id)) errors.push(`duplicate item id: ${id}`);
      ids.add(id);
    }
    if (reference !== undefined && !REFERENCES.has(reference)) errors.push(`${at}.reference is invalid: ${reference}`);
    if (status !== undefined && !STATUSES.has(status)) errors.push(`${at}.status is invalid: ${status}`);
    if (id !== undefined && path !== undefined && reference !== undefined && variant !== undefined) {
      identities.push(`${reference}\t${id}\t${path}\t${variant}`);
    }

    const validation = object(candidate, 'validation', errors);
    if (validation === undefined) continue;
    const dimensions = Object.keys(validation);
    for (const dimension of dimensions) {
      if (!REQUIRED.includes(dimension as typeof REQUIRED[number])) {
        errors.push(`${at}.validation has unknown dimension: ${dimension}`);
        continue;
      }
      const evidence = validation[dimension];
      if (!strings(evidence) || evidence.length === 0) {
        errors.push(`${at}.validation.${dimension} must name at least one test`);
        continue;
      }
      for (const namedTest of evidence) validateTestPath(namedTest, root, tracked, dimension, `${at}.validation.${dimension}`, errors);
    }
    if (status === 'missing' && dimensions.length > 0) errors.push(`${at} cannot be missing with passing validation`);
    if (status === 'parsed-only' && (validation.runtime !== undefined || validation.pty !== undefined)) {
      errors.push(`${at} cannot be parsed-only with runtime or PTY validation`);
    }
    const completionDimensions = reference === 'xi' ? REQUIRED.filter((dimension) => dimension !== 'helix') : REQUIRED;
    const complete = completionDimensions.every((dimension) => validation[dimension] !== undefined);
    if (status === 'effective' && !complete) errors.push(`${at} is effective without every required validation`);
    if (status !== 'effective' && complete) errors.push(`${at} has complete validation but status is not effective`);
  }

  const actualHash = createHash('sha256').update(`${identities.sort().join('\n')}\n`).digest('hex');
  if (sealedHash !== undefined && sealedHash !== actualHash) {
    errors.push(`inventory hash changed: expected ${sealedHash}, actual ${actualHash}; re-audit Helix before resealing`);
  }
  validateFixtureCoverage(items, root, errors);
  return errors;
}

function validateFixtureCoverage(items: readonly Record<string, unknown>[], root: string, errors: string[]): void {
  const fixture = resolve(root, 'tests/fixtures/config/helix-25.07.1.toml');
  const parsed = parseToml(readFileSync(fixture, 'utf8'), 'tests/fixtures/config/helix-25.07.1.toml');
  if (!parsed.ok) {
    errors.push('canonical Helix fixture no longer parses');
    return;
  }
  for (const entry of parsed.value.entries) {
    const path = entry.path.join('.');
    if (!items.some((item) => covers(item, path))) errors.push(`canonical fixture path is absent from ledger: ${path}`);
  }
}

function covers(item: Record<string, unknown>, candidate: string): boolean {
  if (typeof item.path !== 'string') return false;
  if (item.path === candidate) return true;
  if (item.path.endsWith('.*') && candidate.startsWith(item.path.slice(0, -1))) return true;
  return typeof item.variant === 'string'
    && ['command-map', 'pair-table', 'element-catalog'].includes(item.variant)
    && candidate.startsWith(`${item.path}.`);
}

function validateTestPath(value: string, root: string, tracked: ReadonlySet<string>, dimension: string, label: string, errors: string[]): void {
  const [path = '', anchor] = value.split('#', 2);
  const absolute = resolve(root, path);
  if (!path.startsWith('tests/') || (!path.endsWith('.ts') && !path.endsWith('.py'))) {
    errors.push(`${label} must point to a committed TypeScript or Python test: ${value}`);
  } else if (!absolute.startsWith(`${resolve(root)}${sep}`) || !existsSync(absolute)) {
    errors.push(`${label} test does not exist: ${value}`);
  } else {
    if (!tracked.has(path)) errors.push(`${label} test is not committed: ${value}`);
    if (anchor === undefined) {
      if (!path.startsWith('tests/e2e/') || !path.endsWith('-pty.py') || !['runtime', 'pty', 'invalid'].includes(dimension)) {
        errors.push(`${label} needs an assertion anchor: ${value}`);
      }
    } else {
      const labels = anchor ? readFileSync(absolute, 'utf8').match(new RegExp(`[\\'"\x60]${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g')) : null;
      if (labels === null) errors.push(`${label} test anchor does not exist as an assertion label: ${value}`);
      else if (labels.length !== 1) errors.push(`${label} test anchor is not unique: ${value}`);
    }
  }
}

function object(parent: Record<string, unknown>, key: string, errors: string[]): Record<string, unknown> | undefined {
  const value = parent[key];
  if (!record(value)) {
    errors.push(`${key} must be an object`);
    return undefined;
  }
  return value;
}

function text(value: unknown, label: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label} must be a nonempty string`);
    return undefined;
  }
  return value;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const path = resolve(process.argv[2] ?? 'docs/configuration-ledger.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const errors = validateConfigLedger(parsed);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  const ledger = parsed as { readonly items: readonly { readonly reference: string; readonly status: string; readonly validation: Readonly<Record<string, readonly string[]>> }[] };
  const count = (field: 'reference' | 'status', value: string): number => ledger.items.filter((item) => item[field] === value).length;
  const proved = ledger.items.reduce((total, item) => total + Object.keys(item.validation).length, 0);
  const required = ledger.items.reduce((total, item) => total + REQUIRED.length - (item.reference === 'xi' ? 1 : 0), 0);
  console.log(`Config ledger valid: ${ledger.items.length} items; stable=${count('reference', 'stable')} master=${count('reference', 'master')} xi=${count('reference', 'xi')}.`);
  console.log(`Progress: effective=${count('status', 'effective')} parsed-only=${count('status', 'parsed-only')} incompatible=${count('status', 'incompatible')} missing=${count('status', 'missing')}; proved checks=${proved}/${required}.`);
}
