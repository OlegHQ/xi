import { strict as assert } from 'node:assert';
import { NodeFilesystemPort } from '../../packages/platform/src/entrypoints/launch';
import { workspaceLspRootForDocument } from '../../apps/xi/src/wiring/language';

const filesystem = new NodeFilesystemPort();
const root = '/workspace';

assert.equal(workspaceLspRootForDocument(filesystem, root, [], 'file:///workspace/client/src/main.ts'), root, 'T036-WORKSPACE-LSP-ROOTS-UNIT-02 no configured roots use the workspace root');
assert.equal(workspaceLspRootForDocument(filesystem, root, ['client', 'server'], 'file:///workspace/client/src/main.ts'), '/workspace/client', 'T036-WORKSPACE-LSP-ROOTS-UNIT-03 a document uses its configured root');
assert.equal(workspaceLspRootForDocument(filesystem, root, ['client', 'client/nested'], 'file:///workspace/client/nested/src/main.ts'), '/workspace/client/nested', 'T036-WORKSPACE-LSP-ROOTS-UNIT-04 nested roots choose the deepest match');
assert.equal(workspaceLspRootForDocument(filesystem, root, ['client'], 'file:///workspace/clientary/main.ts'), root, 'T036-WORKSPACE-LSP-ROOTS-UNIT-05 root matching respects directory boundaries');

console.log('T036 workspace LSP roots passed: URI decoding, workspace containment, deepest-root selection and boundary matching');
