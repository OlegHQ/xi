import { strict as assert } from 'node:assert';
import { SidebarController, type SidebarOutlineModelPort } from '../../packages/workbench/sidebar/index';

class FakeOutline implements SidebarOutlineModelPort {
  hasSymbols = false;
}

// T-SIDEBAR-01: a visible Files panel starts expanded so startup never paints it collapsed
// before the Explorer opens; Outline starts collapsed when the outline model has no symbols yet.
{
  const outline = new FakeOutline();
  const sidebar = new SidebarController({ outline });
  const model = sidebar.readModel();
  assert.equal(model.sections.find((section) => section.id === 'files')?.expanded, true, 'T-SIDEBAR-01a visible Files starts expanded');
  const hidden = new SidebarController({ outline, initiallyVisible: false });
  assert.equal(hidden.readModel().sections.find((section) => section.id === 'files')?.expanded, false, 'T-SIDEBAR-01a2 hidden sidebar starts with Files collapsed');
  hidden.expandSection('files');
  assert.equal(hidden.readModel().sections.find((section) => section.id === 'files')?.expanded, true, 'T-SIDEBAR-01a3 expandSection expands Files');
  assert.equal(model.sections.find((section) => section.id === 'outline')?.expanded, false, 'T-SIDEBAR-01b Outline starts collapsed with no symbols');
  assert.equal(model.activeSection, 'files', 'T-SIDEBAR-01c Files is the default active section');
}

// T-SIDEBAR-02: Outline auto-expands once the outline model gains symbols, and auto-collapses
// again once it loses them -- without any user toggle.
{
  const outline = new FakeOutline();
  const sidebar = new SidebarController({ outline });
  outline.hasSymbols = true;
  sidebar.refreshOutline();
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, true, 'T-SIDEBAR-02a Outline auto-expands once it has symbols');
  outline.hasSymbols = false;
  sidebar.refreshOutline();
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, false, 'T-SIDEBAR-02b Outline auto-collapses once its symbols are gone');
}

// T-SIDEBAR-03: a user's manual toggle sticks across refreshes that do not change whether the
// outline has symbols, but resets once the symbol presence actually flips.
{
  const outline = new FakeOutline();
  outline.hasSymbols = true;
  const sidebar = new SidebarController({ outline });
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, true, 'starts auto-expanded (symbols present at construction)');

  sidebar.toggleSection('outline');
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, false, 'T-SIDEBAR-03a user collapses it manually');
  sidebar.refreshOutline();
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, false, 'T-SIDEBAR-03b the manual collapse sticks while symbol presence is unchanged');

  outline.hasSymbols = false;
  sidebar.refreshOutline();
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, false, 'T-SIDEBAR-03c symbols disappearing (still no-symbols outcome) resets to auto-collapsed');
  outline.hasSymbols = true;
  sidebar.refreshOutline();
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, true, 'T-SIDEBAR-03d symbols reappearing resets the override and auto-expands again');
}

// T-SIDEBAR-04: width is clamped to 22-40 cells, and begin/move/commit mirrors the editor
// splitter's drag shape -- a move before begin(), or after commit(), has no effect.
{
  const outline = new FakeOutline();
  const sidebar = new SidebarController({ outline, initialWidth: 28 });
  assert.equal(sidebar.width, 28, 'T-SIDEBAR-04a initialWidth is honored when in range');

  sidebar.moveResize(35);
  assert.equal(sidebar.width, 28, 'T-SIDEBAR-04b move() before begin() is a no-op');

  sidebar.beginResize();
  sidebar.moveResize(10);
  assert.equal(sidebar.width, 22, 'T-SIDEBAR-04c width clamps to the 22-cell minimum');
  sidebar.moveResize(90);
  assert.equal(sidebar.width, 40, 'T-SIDEBAR-04d width clamps to the 40-cell maximum');
  sidebar.moveResize(30);
  sidebar.commitResize();
  assert.equal(sidebar.width, 30, 'T-SIDEBAR-04e commit() keeps the last moved-to width');

  sidebar.moveResize(24);
  assert.equal(sidebar.width, 30, 'T-SIDEBAR-04f move() after commit() is a no-op until begin() again');
}

// T-SIDEBAR-05: a persisted width is honored at construction, and commitResize persists it.
{
  const outline = new FakeOutline();
  let persisted = 26;
  const persistence = { get width() { return persisted; }, setWidth: (value: number) => { persisted = value; } };
  const sidebar = new SidebarController({ outline, persistence });
  assert.equal(sidebar.width, 26, 'T-SIDEBAR-05a a persisted width is honored at construction');
  sidebar.beginResize();
  sidebar.moveResize(33);
  sidebar.commitResize();
  assert.equal(persisted, 33, 'T-SIDEBAR-05b commitResize persists the new width');
}

console.log('T-SIDEBAR SidebarController passed default-sections, outline-auto-toggle, user-override, resize-clamp and persistence fixtures');
