import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfigLedger } from '../../tools/check-config-ledger';

type MutableLedger = {
  items: Array<{
    id: string;
    status: string;
    validation: Record<string, string[]>;
  }>;
};

const source = JSON.parse(readFileSync('docs/configuration-ledger.json', 'utf8')) as unknown;
assert.deepEqual(validateConfigLedger(source), []);

const duplicate = structuredClone(source) as MutableLedger;
duplicate.items[1]!.id = duplicate.items[0]!.id;
assert.ok(validateConfigLedger(duplicate).some((error) => error.startsWith('duplicate item id:')));

const incomplete = structuredClone(source) as MutableLedger;
const incompleteItem = incomplete.items.find((item) => item.status !== 'effective');
assert.ok(incompleteItem);
incompleteItem.status = 'effective';
assert.ok(validateConfigLedger(incomplete).some((error) => error.includes('effective without every required validation')));

const missingTest = structuredClone(source) as MutableLedger;
missingTest.items[0]!.validation.schema = ['tests/config/does-not-exist.test.ts'];
assert.ok(validateConfigLedger(missingTest).some((error) => error.includes('test does not exist')));

const missingAnchor = structuredClone(source) as MutableLedger;
missingAnchor.items[0]!.validation.schema = ['tests/config/t036-config.test.ts#DOES-NOT-EXIST'];
assert.ok(validateConfigLedger(missingAnchor).some((error) => error.includes('test anchor does not exist')));

const commentOnlyAnchor = structuredClone(source) as MutableLedger;
commentOnlyAnchor.items[0]!.validation.schema = ['tests/workbench/t116-pointer-router.test.ts#T116-POINTER-05'];
assert.ok(validateConfigLedger(commentOnlyAnchor).some((error) => error.includes('test anchor does not exist')));

const duplicateAnchor = structuredClone(source) as MutableLedger;
duplicateAnchor.items[0]!.validation.schema = ['tests/config/t036-config.test.ts#T036-SOFT-WRAP-05'];
assert.ok(validateConfigLedger(duplicateAnchor).some((error) => error.includes('test anchor is not unique')));

const unrelatedPath = structuredClone(source) as MutableLedger;
unrelatedPath.items[0]!.validation.schema = ['tests/config/t036-config.test.ts'];
assert.ok(validateConfigLedger(unrelatedPath).some((error) => error.includes('needs an assertion anchor')));

const unsealedRemoval = structuredClone(source) as MutableLedger;
unsealedRemoval.items.pop();
assert.ok(validateConfigLedger(unsealedRemoval).some((error) => error.startsWith('inventory hash changed:')));

console.log('Configuration ledger rejects duplicate IDs/anchors, unproven paths, missing tests and unsealed inventory states');
