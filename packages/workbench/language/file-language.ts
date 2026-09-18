/** Pure extension -> languageId mapping used when no languages.toml entry claims a file
 * type. Shared by the composition root's onBufferOpened/onBufferClosed callbacks and by
 * resolveLanguageId (which layers configured [[language]] file-types on top of this). */
export function languageIdForPath(path: string | undefined): string | undefined {
  const extension = path?.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs' || extension === 'jsx') return 'javascript';
  return undefined;
}
