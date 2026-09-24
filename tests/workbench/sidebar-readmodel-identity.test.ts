import { strict as assert } from 'node:assert';
import { SidebarController } from '../../packages/workbench/sidebar/index';

// G6: readModel() memoizes by a key of the fields it reads -- repeated calls with unchanged
// state must return the exact same frozen object (identity-stable), not reallocate every call.
{
  const sidebar = new SidebarController({});
  const first = sidebar.readModel();
  const second = sidebar.readModel();
  assert.equal(first, second, 'G6a readModel() returns the same object when nothing changed');
  assert.equal(first.sections, second.sections, 'G6b the sections array is also reused, not reallocated');

  sidebar.toggleSection('files');
  const third = sidebar.readModel();
  assert.notEqual(third, second, 'G6c a state change (toggling Files) invalidates the cached model');
  const fourth = sidebar.readModel();
  assert.equal(third, fourth, 'G6d the model is stable again once state stops changing');
}

console.log('G6 sidebar readModel() identity-stability fixture passed');
