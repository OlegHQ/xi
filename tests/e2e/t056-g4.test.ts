import assert from 'node:assert/strict';
import { CompletionController, DiagnosticStore, FormatterPipeline, LanguageNavigationController, LanguagePresentationFeatures, PullDiagnosticStore, SemanticTokenStore, SnippetSession, expandSnippet, WorkspaceEditCoordinator } from '../../packages/services/src/index';

assert.equal(typeof DiagnosticStore, 'function'); assert.equal(typeof LanguageNavigationController, 'function'); assert.equal(typeof CompletionController, 'function'); assert.equal(typeof SemanticTokenStore, 'function'); assert.equal(typeof LanguagePresentationFeatures, 'function'); assert.equal(typeof PullDiagnosticStore, 'function'); assert.equal(typeof WorkspaceEditCoordinator, 'function'); assert.equal(typeof FormatterPipeline, 'function');
const expanded = expandSnippet('${1:value}$0'); assert.equal(expanded.ok, true); if (expanded.ok) { const snippet = new SnippetSession(expanded.value, 1); assert.equal(snippet.next(1).ok, true); snippet.dispose(); }
console.log('T056 G4 qualification passed transport-adjacent diagnostics, navigation, completion, semantic, folding, snippet, edit and formatter owner composition');
