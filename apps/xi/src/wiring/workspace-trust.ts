import { CancellationSource, type CancellationToken } from '../../../../packages/primitives/src/entrypoints/launch';
import type { NodeFilesystemPort } from '../../../../packages/platform/src/entrypoints/launch';
import { workspaceTrustAllows, type WorkspaceTrustConfig, type WorkspaceTrustDecision, type WorkspaceTrustResolver } from '../../../../packages/services/src/entrypoints/config';

const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_HELIX_FILES = 4096;
const MAX_HELIX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_HELIX_BYTES = 16 * 1024 * 1024;

interface WorkspaceTrustRecord {
  readonly version: typeof RECORD_VERSION;
  readonly path: string;
  readonly hash: string | null;
  readonly excluded: boolean;
}

export interface WorkspaceTrustCommands {
  trust(): Promise<boolean>;
  untrust(): Promise<boolean>;
  exclude(): Promise<boolean>;
  attachReload(reload: () => Promise<boolean>): void;
}

export interface WorkspaceTrustWiring extends WorkspaceTrustResolver, WorkspaceTrustCommands {
  readonly allowsServers: () => boolean;
  readonly allowsGit: () => boolean;
}

export function workspaceTrustStateDirectory(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = environment.HOME ?? process.cwd();
  return `${environment.XDG_DATA_HOME ?? `${home}/.local/share`}/xi/workspace_trust`;
}

export function createWorkspaceTrustWiring(
  filesystem: NodeFilesystemPort,
  workspaceRoot: string,
  stateDirectory: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkspaceTrustWiring {
  let reload: (() => Promise<boolean>) | undefined;
  let lastDecision: WorkspaceTrustDecision | undefined;
  const root = normalizePath(workspaceRoot);

  const resolve = async (currentRoot: string, config: WorkspaceTrustConfig, cancellation: CancellationToken): Promise<WorkspaceTrustDecision> => {
    const normalizedRoot = normalizePath(currentRoot);
    const implicit = workspaceTrustAllows(normalizedRoot, config, environment);
    const defaults = (workspaceConfigAllowed: boolean, stale: boolean): WorkspaceTrustDecision => Object.freeze({
      workspaceConfigAllowed,
      serversAllowed: config.level !== 'none' || workspaceConfigAllowed,
      gitAllowed: config.level === 'insecure' || workspaceConfigAllowed,
      stale,
    });
    const record = await readRecord(filesystem, recordPath(stateDirectory, normalizedRoot), cancellation);
    if (record !== undefined && record.path !== normalizedRoot) {
      lastDecision = defaults(false, false);
      return lastDecision;
    }
    if (record === undefined) {
      lastDecision = defaults(implicit, false);
      return lastDecision;
    }
    if (record.excluded) {
      lastDecision = defaults(false, false);
      return lastDecision;
    }
    if (record.hash === null) {
      lastDecision = defaults(implicit, false);
      return lastDecision;
    }
    const currentHash = await hashHelixDirectory(filesystem, `${normalizedRoot}/.helix`, cancellation);
    const fresh = currentHash !== undefined && currentHash === record.hash;
    if (implicit) {
      lastDecision = defaults(true, false);
      return lastDecision;
    }
    lastDecision = defaults(fresh, !fresh);
    if (fresh) lastDecision = Object.freeze({ workspaceConfigAllowed: true, serversAllowed: true, gitAllowed: true, stale: false });
    return lastDecision;
  };

  const write = async (record: WorkspaceTrustRecord): Promise<boolean> => {
    const cancellation = new CancellationSource();
    try {
      const directory = await filesystem.makeDirectory(stateDirectory, cancellation.token);
      if (!directory.ok) return false;
      const result = await filesystem.writeFileAtomic(recordPath(stateDirectory, record.path), new TextEncoder().encode(JSON.stringify(record) + '\n'), cancellation.token);
      return result.ok;
    } finally {
      cancellation.dispose();
    }
  };

  const command = async (kind: 'trust' | 'untrust' | 'exclude'): Promise<boolean> => {
    const cancellation = new CancellationSource();
    try {
      const hash = kind === 'trust' ? await hashHelixDirectory(filesystem, `${root}/.helix`, cancellation.token) : null;
      if (hash === undefined) return false;
      const saved = await write({ version: RECORD_VERSION, path: root, hash, excluded: kind === 'exclude' });
      if (!saved) return false;
      return reload === undefined ? true : await reload();
    } finally {
      cancellation.dispose();
    }
  };

  return {
    resolve,
    allowsServers: () => lastDecision?.serversAllowed ?? true,
    allowsGit: () => lastDecision?.gitAllowed ?? true,
    trust: () => command('trust'),
    untrust: () => command('untrust'),
    exclude: () => command('exclude'),
    attachReload: (next) => { reload = next; },
  };
}

async function readRecord(filesystem: NodeFilesystemPort, path: string, cancellation: CancellationToken): Promise<WorkspaceTrustRecord | undefined> {
  const read = await filesystem.readFile(path, cancellation, { maxBytes: MAX_RECORD_BYTES });
  if (!read.ok) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.value));
    if (!isRecord(value) || value.version !== RECORD_VERSION || typeof value.path !== 'string' || typeof value.hash !== 'string' && value.hash !== null || typeof value.excluded !== 'boolean') return undefined;
    if (value.hash !== null && !/^sha256:[0-9a-f]{64}$/u.test(value.hash)) return undefined;
    return Object.freeze({ version: RECORD_VERSION, path: value.path, hash: value.hash, excluded: value.excluded });
  } catch {
    return undefined;
  }
}

async function hashHelixDirectory(filesystem: NodeFilesystemPort, directory: string, cancellation: CancellationToken): Promise<string | undefined> {
  const entries: { readonly relativePath: string; readonly absolutePath: string }[] = [];
  const enumerated = await filesystem.enumerateFiles(directory, cancellation, (batch) => {
    for (const entry of batch) entries.push({ relativePath: entry.relativePath, absolutePath: entry.absolutePath });
  }, { maxEntries: MAX_HELIX_FILES, ignoredDirectoryNames: [], followSymlinks: false, deduplicateLinks: true });
  if (!enumerated.ok) return enumerated.error.code === 'ENOENT' || enumerated.error.code === 'ENOTDIR' ? hashBytes([]) : undefined;
  const enumeratedPaths = new Set(entries.map((entry) => entry.relativePath));
  for (const relativePath of ['config.toml', 'languages.toml']) {
    if (enumeratedPaths.has(relativePath)) continue;
    const path = `${directory}/${relativePath}`;
    const read = await filesystem.readFile(path, cancellation, { maxBytes: MAX_HELIX_FILE_BYTES });
    if (read.ok) entries.push({ relativePath, absolutePath: path });
    else if (read.error.code !== 'ENOENT' && read.error.code !== 'ENOTDIR') return undefined;
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hasher = new Bun.CryptoHasher('sha256');
  let total = 0;
  for (const entry of entries) {
    const bytes = await filesystem.readFile(entry.absolutePath, cancellation, { maxBytes: MAX_HELIX_FILE_BYTES });
    if (!bytes.ok) return undefined;
    total += bytes.value.byteLength;
    if (total > MAX_HELIX_BYTES) return undefined;
    hasher.update(entry.relativePath);
    hasher.update('\0');
    hasher.update(bytes.value);
    hasher.update('\0');
  }
  return `sha256:${hasher.digest('hex')}`;
}

function hashBytes(bytes: readonly number[]): string {
  return `sha256:${Bun.CryptoHasher.hash('sha256', new Uint8Array(bytes), 'hex')}`;
}

function recordPath(directory: string, root: string): string {
  return `${directory}/${Bun.CryptoHasher.hash('sha256', root, 'hex')}.json`;
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replaceAll(/\/+/gu, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/u, '') : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
