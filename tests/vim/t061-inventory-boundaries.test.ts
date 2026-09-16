import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const inventory = JSON.parse(await readFile(resolve(root, 'docs/compatibility/neovim-0.12.4.json'), 'utf8')) as {
  readonly counts: { readonly total: number };
  readonly entries: readonly { readonly helpTag: string; readonly implementingTicket: string }[];
};
const audit = JSON.parse(await readFile(resolve(root, 'docs/compatibility/t061-boundaries.json'), 'utf8')) as {
  readonly ticket: string;
  readonly rows: readonly { readonly helpTag: string; readonly status: string; readonly boundary: string; readonly reason: string }[];
};

assert.equal(inventory.counts.total, 597, 'T061-INVENTORY-01 pinned inventory retains all 597 rows');
assert.equal(audit.ticket, 'T061', 'T061-INVENTORY-02 boundary audit names its owner ticket');
const remaining = inventory.entries.filter((entry) => entry.implementingTicket === 'T061').map((entry) => entry.helpTag).sort();
const accounted = audit.rows.map((row) => row.helpTag).sort();
assert.deepEqual(accounted, remaining, 'T061-INVENTORY-03 every remaining audit row has exactly one reviewed boundary record');
for (const row of audit.rows) {
  assert.ok(row.boundary.length > 0, `T061-INVENTORY-04 ${row.helpTag} has a concrete boundary`);
  assert.ok(row.reason.length > 0, `T061-INVENTORY-05 ${row.helpTag} explains its boundary`);
  assert.ok(row.status === 'excluded-with-boundary' || row.status === 'partial' || row.status === 'verified',
    `T061-INVENTORY-06 ${row.helpTag} uses an allowed audit status`);
}
console.log(`T061 inventory boundary audit accounts for ${remaining.length} remaining rows of the pinned ${inventory.counts.total}-row index`);
