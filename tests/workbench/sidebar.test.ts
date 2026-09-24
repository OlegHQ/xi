import { strict as assert } from 'node:assert';
import { SidebarController } from '../../packages/workbench/sidebar/index';

// T-SIDEBAR-01: a visible Files panel starts expanded so startup never paints it collapsed
// before the Explorer opens; Outline starts collapsed.
{
  const sidebar = new SidebarController({});
  const model = sidebar.readModel();
  assert.equal(model.sections.find((section) => section.id === 'files')?.expanded, true, 'T-SIDEBAR-01a visible Files starts expanded');
  const hidden = new SidebarController({ initiallyVisible: false });
  assert.equal(hidden.readModel().sections.find((section) => section.id === 'files')?.expanded, false, 'T-SIDEBAR-01a2 hidden sidebar starts with Files collapsed');
  hidden.expandSection('files');
  assert.equal(hidden.readModel().sections.find((section) => section.id === 'files')?.expanded, true, 'T-SIDEBAR-01a3 expandSection expands Files');
  assert.equal(model.sections.find((section) => section.id === 'outline')?.expanded, false, 'T-SIDEBAR-01b Outline starts collapsed');
  assert.equal(model.activeSection, 'files', 'T-SIDEBAR-01c Files is the default active section');
}

// T-SIDEBAR-02: Outline expansion is user-controlled; `outlineVisible` is true only while its
// rows are on screen (sidebar shown, Files tab, section expanded).
{
  let panel: 'files' | 'search' | 'git' = 'files';
  const sidebar = new SidebarController({ panelState: () => panel });
  assert.equal(sidebar.outlineVisible, false, 'T-SIDEBAR-02a collapsed Outline is not visible');
  sidebar.toggleSection('outline');
  assert.equal(sidebar.readModel().sections.find((section) => section.id === 'outline')?.expanded, true, 'T-SIDEBAR-02b toggle expands Outline');
  assert.equal(sidebar.outlineVisible, true, 'T-SIDEBAR-02c expanded Outline on the Files tab is visible');
  panel = 'search';
  assert.equal(sidebar.outlineVisible, false, 'T-SIDEBAR-02d another sidebar tab hides the Outline rows');
  panel = 'files';
  sidebar.setVisible(false);
  assert.equal(sidebar.outlineVisible, false, 'T-SIDEBAR-02e a hidden sidebar hides the Outline rows');
  sidebar.setVisible(true);
  sidebar.toggleSection('outline');
  assert.equal(sidebar.outlineVisible, false, 'T-SIDEBAR-02f toggling again collapses it');
}

// T-SIDEBAR-04: width is clamped to 22-40 cells, and begin/move/commit mirrors the editor
// splitter's drag shape -- a move before begin(), or after commit(), has no effect.
{
  const sidebar = new SidebarController({ initialWidth: 28 });
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
  let persisted = 26;
  const persistence = { get width() { return persisted; }, setWidth: (value: number) => { persisted = value; } };
  const sidebar = new SidebarController({ persistence });
  assert.equal(sidebar.width, 26, 'T-SIDEBAR-05a a persisted width is honored at construction');
  sidebar.beginResize();
  sidebar.moveResize(33);
  sidebar.commitResize();
  assert.equal(persisted, 33, 'T-SIDEBAR-05b commitResize persists the new width');
}

console.log('T-SIDEBAR SidebarController passed default-sections, outline-toggle/visibility, resize-clamp and persistence fixtures');
