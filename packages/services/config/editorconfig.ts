import type { CancellationToken, PlatformFailure, Result } from '../../contracts/src/index';

type EditorConfigKey = 'indent_style' | 'indent_size' | 'tab_width' | 'end_of_line' | 'insert_final_newline' | 'trim_trailing_whitespace';
const KEYS = new Set<EditorConfigKey>(['indent_style', 'indent_size', 'tab_width', 'end_of_line', 'insert_final_newline', 'trim_trailing_whitespace']);
const MAX_BYTES = 256 * 1024;

export interface EditorConfigProperties {
  readonly indentStyle?: 'tab' | 'space';
  readonly indentSize?: number | 'tab';
  readonly tabWidth?: number;
  readonly endOfLine?: 'lf' | 'cr' | 'crlf';
  readonly insertFinalNewline?: boolean;
  readonly trimTrailingWhitespace?: boolean;
}

export interface EditorConfigFilesystem {
  readFile(path: string, cancellation: CancellationToken, options?: { readonly maxBytes?: number }): Promise<Result<Uint8Array, PlatformFailure>>;
  directoryPath(path: string): string;
}

interface Section { readonly pattern: string; readonly values: readonly (readonly [EditorConfigKey, string])[]; }
interface ParsedFile { readonly root: boolean; readonly sections: readonly Section[]; }

/** Read nearest .editorconfig files off the input path; a nearer matching section wins. */
export async function readEditorConfig(filesystem: EditorConfigFilesystem, path: string, cancellation: CancellationToken): Promise<Result<EditorConfigProperties, { readonly message: string }>> {
  const files: { readonly directory: string; readonly parsed: ParsedFile }[] = [];
  let directory = filesystem.directoryPath(path);
  for (let depth = 0; depth < 64; depth += 1) {
    if (cancellation.isCancelled) return { ok: false, error: { message: 'EditorConfig read was cancelled' } };
    const configPath = `${directory === '/' ? '' : directory}/.editorconfig`;
    const read = await filesystem.readFile(configPath, cancellation, { maxBytes: MAX_BYTES });
    if (read.ok) {
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(read.value); }
      catch { return { ok: false, error: { message: `${configPath} is not UTF-8` } }; }
      const parsed = parseEditorConfig(source);
      files.push({ directory, parsed });
      if (parsed.root) break;
    } else if (read.error.code !== 'ENOENT' && read.error.code !== 'not-found' && read.error.code !== 'ENOTDIR') {
      return { ok: false, error: { message: `${configPath}: ${read.error.message}` } };
    }
    const parent = filesystem.directoryPath(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const values = new Map<EditorConfigKey, string>();
  for (const file of files.reverse()) {
    const relative = path.slice(file.directory.length).replace(/^[/\\]/u, '').replaceAll('\\', '/');
    for (const section of file.parsed.sections) {
      const pattern = section.pattern.startsWith('/') ? section.pattern.slice(1) : section.pattern;
      let matches = false;
      try { matches = new Bun.Glob(pattern).match(pattern.includes('/') ? relative : relative.split('/').at(-1) ?? relative); }
      catch { continue; }
      if (!matches) continue;
      for (const [key, value] of section.values) {
        if (value === 'unset') values.delete(key);
        else values.set(key, value);
      }
    }
  }
  const integer = (key: EditorConfigKey): number | undefined => {
    const value = values.get(key);
    if (value === undefined || !/^[1-9]\d*$/u.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= 256 ? parsed : undefined;
  };
  const bool = (key: EditorConfigKey): boolean | undefined => values.get(key) === 'true' ? true : values.get(key) === 'false' ? false : undefined;
  const style = values.get('indent_style');
  const ending = values.get('end_of_line');
  const indentSize = values.get('indent_size') === 'tab' ? 'tab' as const : integer('indent_size');
  const tabWidth = integer('tab_width');
  const insertFinalNewline = bool('insert_final_newline');
  const trimTrailingWhitespace = bool('trim_trailing_whitespace');
  return { ok: true, value: Object.freeze({
    ...(style === 'tab' || style === 'space' ? { indentStyle: style } : {}),
    ...(indentSize === undefined ? {} : { indentSize }),
    ...(tabWidth === undefined ? {} : { tabWidth }),
    ...(ending === 'lf' || ending === 'cr' || ending === 'crlf' ? { endOfLine: ending } : {}),
    ...(insertFinalNewline === undefined ? {} : { insertFinalNewline }),
    ...(trimTrailingWhitespace === undefined ? {} : { trimTrailingWhitespace }),
  }) };
}

function parseEditorConfig(source: string): ParsedFile {
  let root = false;
  const sections: { pattern: string; values: [EditorConfigKey, string][] }[] = [];
  let current: (typeof sections)[number] | undefined;
  for (const raw of source.replace(/^\uFEFF/u, '').split(/\r\n|\n|\r/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = { pattern: line.slice(1, -1), values: [] };
      sections.push(current);
      continue;
    }
    const separator = line.search(/[=:]/u);
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().toLowerCase();
    if (current === undefined) { if (key === 'root' && value === 'true') root = true; continue; }
    if (KEYS.has(key as EditorConfigKey)) current.values.push([key as EditorConfigKey, value]);
  }
  return { root, sections };
}
