/** CLI argv parsing only -- no service/port construction, matching the ownership table's
 * "construct, wire, start, stop, CLI parsing" for apps/xi. */

export type CliAction =
  | { readonly kind: 'help'; readonly text: string }
  | { readonly kind: 'version'; readonly text: string }
  | { readonly kind: 'health'; readonly text: string }
  | { readonly kind: 'launch'; readonly fileArgument: string | undefined };

const HELP_TEXT = 'Xi editor\n\nUsage: xi [options] [file[:line]]\n\nOptions:\n  --help       Show this help\n  --version    Show the version\n  --health     Check the local runtime\n';

export function parseCliArgs(argv: readonly string[], version: string): CliAction {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help', text: HELP_TEXT };
  if (argv.includes('--version') || argv.includes('-v')) return { kind: 'version', text: `xi ${version}\n` };
  if (argv.includes('--health')) return { kind: 'health', text: `xi ${version} health: OpenTUI workbench available\n` };
  return { kind: 'launch', fileArgument: argv.find((arg) => !arg.startsWith('-')) };
}

export interface ResolvedFileArgument {
  readonly path: string;
  readonly label: string;
  readonly line?: number;
}

export function resolveFileArgument(argument: string, cwd: string): ResolvedFileArgument {
  const match = /^(.*):(\d+)$/u.exec(argument);
  const given = match?.[1] ?? argument;
  const separator = Math.max(given.lastIndexOf('/'), given.lastIndexOf('\\'));
  const label = given.slice(separator + 1) || given;
  // Resolve to an absolute-looking path so this buffer's stored path is directly
  // comparable (via filesystem.workspaceRelativePath, which normalizes with
  // node:path's own resolve()) with every other subsystem's absolute/workspace-
  // relative paths (picker index, Explorer, search, LSP) -- a bare relative CLI
  // argument previously stayed relative and silently failed those comparisons,
  // producing a duplicate buffer for the same file when reopened via the picker.
  // Architecture forbids importing node:path outside packages/platform, so this is
  // a plain prefix join; workspaceRelativePath's own resolve() finishes normalizing
  // any '.'/'..' segments whenever it's actually compared against another path.
  const path = given.startsWith('/') ? given : `${cwd}/${given}`;
  return match === null ? { path, label } : { path, label, line: Number(match[2]) };
}
