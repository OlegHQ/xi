import assert from 'node:assert/strict';
import { CancellationSource } from '../../packages/contracts/src/index';
import { readEditorConfig } from '../../packages/services/config/editorconfig';

const files = new Map([
  ['/project/.editorconfig', 'root = true\n[*]\nindent_style = space\nindent_size = 4\nend_of_line = crlf\ninsert_final_newline = false\n[*.ts]\ntrim_trailing_whitespace = true\n'],
  ['/project/src/.editorconfig', '[*.ts]\nindent_size = 2\nend_of_line = unset\n[*.md]\nindent_style = tab\n'],
  ['/.editorconfig', '[*]\nindent_size = 8\n'],
]);
const reads: string[] = [];
const filesystem = {
  directoryPath: (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
  async readFile(path: string) {
    reads.push(path);
    const source = files.get(path);
    return source === undefined
      ? { ok: false as const, error: { code: 'ENOENT', message: 'missing', retryable: false } }
      : { ok: true as const, value: new TextEncoder().encode(source) };
  },
};
const cancellation = new CancellationSource();
try {
  const ts = await readEditorConfig(filesystem, '/project/src/main.ts', cancellation.token);
  assert.equal(ts.ok, true, 'EDITORCONFIG-01 layered config resolves');
  if (ts.ok) assert.deepEqual(ts.value, { indentStyle: 'space', indentSize: 2, insertFinalNewline: false, trimTrailingWhitespace: true });
  assert.equal(reads.includes('/.editorconfig'), false, 'EDITORCONFIG-02 root=true stops ancestor reads');
  const md = await readEditorConfig(filesystem, '/project/src/readme.md', cancellation.token);
  assert.equal(md.ok, true);
  if (md.ok) assert.deepEqual(md.value, { indentStyle: 'tab', indentSize: 4, endOfLine: 'crlf', insertFinalNewline: false });
  const outside = await readEditorConfig(filesystem, '/outside/file.ts', cancellation.token);
  assert.equal(outside.ok, true);
  if (outside.ok) assert.deepEqual(outside.value, { indentSize: 8 }, 'EDITORCONFIG-03 filesystem root applies outside project');
} finally { cancellation.dispose(); }

console.log('EditorConfig reader passed root, layering, sections, unset and ancestor checks');
