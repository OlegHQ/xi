/** Pure extension -> languageId mapping used when no languages.toml entry claims a file
 * type. Shared by the composition root's onBufferOpened/onBufferClosed callbacks and by
 * resolveLanguageId (which layers configured [[language]] file-types on top of this). */
export function languageIdForPath(path: string | undefined): string | undefined {
  const fileName = path?.split(/[\\/]/u).at(-1)?.toLowerCase();
  const extension = fileName?.slice(fileName.lastIndexOf('.') + 1);
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs' || extension === 'jsx') return 'javascript';
  if (extension === 'py' || extension === 'pyi') return 'python';
  if (extension === 'rb' || extension === 'rake' || extension === 'gemspec') return 'ruby';
  if (fileName === 'gemfile' || fileName === 'rakefile' || fileName === 'guardfile' || fileName === 'podfile' || fileName === 'vagrantfile' || fileName === '.irbrc') return 'ruby';
  if (extension === 'json' || extension === 'jsonc') return 'json';
  if (extension === 'toml') return 'toml';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return undefined;
}
