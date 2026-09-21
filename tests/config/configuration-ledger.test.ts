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

const unsealedRemoval = structuredClone(source) as MutableLedger;
unsealedRemoval.items.pop();
assert.ok(validateConfigLedger(unsealedRemoval).some((error) => error.startsWith('inventory hash changed:')));

console.log('Configuration ledger rejects duplicate, unproven, missing-test and unsealed inventory states');
