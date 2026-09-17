/** Pure ctags (tags file) parsing: no filesystem access, no host navigation semantics. Callers
 * read the file, cap its size before decoding if desired, and use `parseCtags`/`lookupCtags` to
 * find entries by name. */

export interface CtagsRecord {
  readonly name: string;
  /** The path field exactly as written in the tags file (relative or absolute); resolving it
   * against the tags file's directory is the caller's job, since that needs a filesystem port. */
  readonly path: string;
  /** Zero-based line number decoded from the ex-command address field, defaulting to 0 when the
   * address does not carry a recognizable line number. */
  readonly line: number;
}

const LINE_ADDRESS = /(?:^|;)line:([1-9][0-9]*)/;
const NUMERIC_ADDRESS = /^(?:[?/]?(\d+))(?:;"|[/?])?$/u;

/** Parses ctags (Universal/Exuberant) tab-separated tag lines, skipping `!_TAG_` pseudo-tag
 * headers. Supports both the `line:N` extension field and a bare/`;"`-terminated numeric
 * ex-command address; other ex-command addresses (search patterns) default to line 0, matching
 * the behavior of a `:tag` jump that then relies on a text search. When `options.maxBytes` is
 * given and the UTF-8 byte length of `text` exceeds it, returns no records (the file is treated
 * as too large to trust, the same as skipping it before reading). */
export function parseCtags(text: string, options?: { readonly maxBytes?: number }): readonly CtagsRecord[] {
  if (options?.maxBytes !== undefined && new TextEncoder().encode(text).byteLength > options.maxBytes) return Object.freeze([]);
  const records: CtagsRecord[] = [];
  for (const row of text.split('\n')) {
    if (row.length === 0 || row.startsWith('!_TAG_')) continue;
    const fields = row.replace(/\r$/u, '').split('\t');
    const name = fields[0];
    const path = fields[1];
    const address = fields[2];
    if (name === undefined || path === undefined || address === undefined) continue;
    const lineMatch = LINE_ADDRESS.exec(address);
    const numericMatch = NUMERIC_ADDRESS.exec(address);
    const lineNumber = lineMatch?.[1] ?? numericMatch?.[1];
    const line = lineNumber === undefined ? 0 : Number(lineNumber) - 1;
    if (!Number.isSafeInteger(line) || line < 0) continue;
    records.push(Object.freeze({ name, path, line }));
  }
  return Object.freeze(records);
}

/** Returns every record whose tag name matches exactly. */
export function lookupCtags(records: readonly CtagsRecord[], name: string): readonly CtagsRecord[] {
  return Object.freeze(records.filter((record) => record.name === name));
}
