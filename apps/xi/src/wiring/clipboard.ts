import type { ClipboardPort, CancellationToken, Disposable, PlatformFailure, Result } from '../../../../packages/contracts/src/entrypoints/launch';
import type { ClipboardCommandConfig, ClipboardProviderConfig } from '../../../../packages/services/src/entrypoints/config';
import type { NodeProcessPort } from '../../../../packages/platform/src/entrypoints/launch';

const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;

/** Selects the configured Helix provider while keeping command execution behind ProcessPort. */
export function createConfiguredClipboardPort(
  provider: ClipboardProviderConfig,
  builtin: ClipboardPort,
  ProcessPort: typeof NodeProcessPort,
  cwd: string,
  termcode: ClipboardPort = builtin,
): ClipboardPort & Disposable {
  if (provider.kind === 'builtin') {
    if (provider.name === 'platform' || provider.name === 'windows') return builtin as ClipboardPort & Disposable;
    if (provider.name === 'termcode') return termcode as ClipboardPort & Disposable;
    if (provider.name === 'none') return noClipboardPort();
    const commands = builtinCommands(provider.name);
    if (commands !== undefined) return createCommandClipboardPort(commands, ProcessPort, cwd);
    return builtin as ClipboardPort & Disposable;
  }
  return createCommandClipboardPort({ yank: provider.yank, paste: provider.paste, ...(provider.primaryYank === undefined ? {} : { primaryYank: provider.primaryYank }), ...(provider.primaryPaste === undefined ? {} : { primaryPaste: provider.primaryPaste }) }, ProcessPort, cwd);
}

interface ClipboardCommandSet {
  readonly yank: ClipboardCommandConfig;
  readonly paste: ClipboardCommandConfig;
  readonly primaryYank?: ClipboardCommandConfig;
  readonly primaryPaste?: ClipboardCommandConfig;
}

function createCommandClipboardPort(commands: ClipboardCommandSet, ProcessPort: typeof NodeProcessPort, cwd: string): ClipboardPort & Disposable {
  const process = new ProcessPort();
  return {
    readText: cancellation => runClipboardCommand(commands.yank, undefined, process, cwd, cancellation),
    writeText: (text, cancellation) => runClipboardCommand(commands.paste, text, process, cwd, cancellation).then(toWriteResult),
    ...(commands.primaryYank === undefined ? {} : { readPrimaryText: (cancellation: CancellationToken) => runClipboardCommand(commands.primaryYank!, undefined, process, cwd, cancellation) }),
    ...(commands.primaryPaste === undefined ? {} : { writePrimaryText: (text: string, cancellation: CancellationToken) => runClipboardCommand(commands.primaryPaste!, text, process, cwd, cancellation).then(toWriteResult) }),
    dispose: () => {},
  };
}

function builtinCommands(name: string): ClipboardCommandSet | undefined {
  const command = (program: string, ...args: string[]): ClipboardCommandConfig => Object.freeze({ command: program, args: Object.freeze(args) });
  switch (name) {
    case 'pasteboard': return { yank: command('pbpaste'), paste: command('pbcopy') };
    case 'wayland': return { yank: command('wl-paste', '--no-newline'), paste: command('wl-copy', '--type', 'text/plain'), primaryYank: command('wl-paste', '-p', '--no-newline'), primaryPaste: command('wl-copy', '-p', '--type', 'text/plain') };
    case 'x-clip': return { yank: command('xclip', '-o', '-selection', 'clipboard'), paste: command('xclip', '-i', '-selection', 'clipboard'), primaryYank: command('xclip', '-o'), primaryPaste: command('xclip', '-i') };
    case 'x-sel': return { yank: command('xsel', '-o', '-b'), paste: command('xsel', '-i', '-b'), primaryYank: command('xsel', '-o'), primaryPaste: command('xsel', '-i') };
    case 'tmux': return { yank: command('tmux', 'save-buffer', '-'), paste: command('tmux', 'load-buffer', '-w', '-') };
    case 'termux': return { yank: command('termux-clipboard-get'), paste: command('termux-clipboard-set') };
    case 'win32-yank': return { yank: command('win32yank.exe', '-o', '--lf'), paste: command('win32yank.exe', '-i', '--crlf') };
    default: return undefined;
  }
}

function noClipboardPort(): ClipboardPort & Disposable {
  return {
    readText: async () => failure('clipboard provider is disabled'),
    writeText: async () => ({ ok: true, value: undefined }),
    dispose: () => {},
  };
}

function toWriteResult(result: Result<string, PlatformFailure>): Result<void, PlatformFailure> {
  return result.ok ? { ok: true, value: undefined } : result;
}

async function runClipboardCommand(
  command: ClipboardCommandConfig,
  input: string | undefined,
  process: NodeProcessPort,
  cwd: string,
  cancellation: CancellationToken,
): Promise<Result<string, PlatformFailure>> {
  const spawned = await process.spawn({
    argv: [command.command, ...command.args],
    cwd,
    env: processEnvironment(),
    ...(input === undefined ? { stdin: 'ignore' as const } : { stdin: 'pipe' as const }),
    timeoutMilliseconds: 5000,
    cancellation,
  });
  if (!spawned.ok) return spawned;
  const handle = spawned.value;
  const stdoutPromise = collect(handle.stdout);
  const stderrPromise = collect(handle.stderr);
  if (input !== undefined) {
    if (handle.stdin === null) {
      await handle.terminate(250);
      handle.dispose();
      return failure('clipboard command has no stdin');
    }
    const written = await handle.stdin.write(new TextEncoder().encode(input));
    if (!written.ok) {
      await handle.terminate(250);
      handle.dispose();
      return written;
    }
    const closed = await handle.stdin.close();
    if (!closed.ok) {
      await handle.terminate(250);
      handle.dispose();
      return closed;
    }
  }
  const [stdout, stderr, exited] = await Promise.all([stdoutPromise, stderrPromise, handle.exit]);
  handle.dispose();
  if (!stdout.ok) return stdout;
  if (!stderr.ok) return stderr;
  if (!exited.ok) return exited;
  if (exited.value.code !== 0) {
    const detail = decode(stderr.value);
    return failure(`clipboard command exited with ${exited.value.code ?? 'a signal'}${detail.length === 0 ? '' : `: ${detail}`}`);
  }
  return decodeResult(stdout.value);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Result<Uint8Array, PlatformFailure>> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > MAX_CLIPBOARD_BYTES) return failure('clipboard command output exceeded 16 MiB');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, value: bytes };
}

function decodeResult(bytes: Uint8Array): Result<string, PlatformFailure> {
  try { return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch { return failure('clipboard command returned invalid UTF-8'); }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).trim();
}

function processEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
  return environment;
}

function failure(message: string): Result<never, PlatformFailure> {
  return { ok: false, error: { code: 'clipboard-command-failed', message, retryable: true } };
}
