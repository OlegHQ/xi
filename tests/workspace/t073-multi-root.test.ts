import {
  FilePathIndex,
  InMemorySearchBackend,
  RealtimeSearchService,
  createLanguageServerIdentity,
} from '../../packages/services/src/index';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const index = new FilePathIndex({ maxEntries: 8 });
assert(index.addRoot({ id: 'root-a', label: 'A', path: '/workspace/a' }).ok, 'root-a should register');
assert(index.addRoot({ id: 'root-b', label: 'B', path: '/workspace/b' }).ok, 'root-b should register');
assert(!index.addRoot({ id: 'root-a', label: 'duplicate', path: '/other' }).ok, 'duplicate root must be rejected');
assert(index.addPaths('root-a', [{ rootId: 'root-a', relativePath: 'src/index.ts', absolutePath: '/workspace/a/src/index.ts' }]).ok, 'root-a path should index');
assert(index.addPaths('root-b', [{ rootId: 'root-b', relativePath: 'src/index.ts', absolutePath: '/workspace/b/src/index.ts' }]).ok, 'root-b path should index');
index.markReady();
const files = index.query('src/index.ts', { limit: 10 });
assert(!('kind' in files), 'multi-root query should be ready');
assert(files.entries.length === 2, 'same relative path must produce two entries');
assert(new Set(files.entries.map((entry) => entry.id)).size === 2, 'root identity must be part of entry identity');
assert(new Set(files.entries.map((entry) => entry.rootId)).size === 2, 'query must retain root IDs');
assert(files.entries.every((entry) => entry.relativePath === 'src/index.ts'), 'relative path should remain stable');
index.removeRoot('root-a');
const remaining = index.query('src/index.ts', { limit: 10 });
assert(!('kind' in remaining) && remaining.entries.length === 1 && remaining.entries[0]?.rootId === 'root-b', 'removing one root must not remove its sibling');
index.dispose();

const search = new RealtimeSearchService({
  debounceMilliseconds: 0,
  backend: new InMemorySearchBackend([
    { rootId: 'root-a', path: 'src/index.ts', text: 'needle A' },
    { rootId: 'root-b', path: 'src/index.ts', text: 'needle B' },
  ]),
});
const searchResult = await search.query({ rootId: 'root-b', rootPath: '/workspace/b', query: 'needle' });
assert(searchResult.ok && searchResult.value.matches.length === 1, 'search should remain scoped to one root');
assert(searchResult.ok && searchResult.value.matches[0]?.rootId === 'root-b', 'search result must carry root identity');
search.dispose();

const config = { name: 'typescript', command: 'typescript-language-server', args: [] } as const;
const languageA = createLanguageServerIdentity({ config, root: '/workspace/a', workspaceId: 'workspace' });
const languageB = createLanguageServerIdentity({ config, root: '/workspace/b', workspaceId: 'workspace' });
assert(languageA.key !== languageB.key, 'language sessions must not collide across roots');

console.log('T073 multi-root qualification passed path, search and language-session identity checks');
