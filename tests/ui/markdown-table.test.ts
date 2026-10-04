import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { MarkdownRenderable, SyntaxStyle, RGBA } from '@opentui/core';
import { createMarkdownTable } from '../../packages/ui/src/solid/markdown-table';

const theme = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  muted: '#6e7681',
  accent: '#79c0ff',
};

// 1. Column alignment (left, center, right)
{
  const setup = await createTestRenderer({ width: 80, height: 10, bufferedOutput: 'memory' });
  const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } });

  const mdContent = `
| Left | Center | Right |
| :--- | :----: | ----: |
| L    |   C    |     R |
| Word | Mid | 12345 |
`;

  const md = new MarkdownRenderable(setup.renderer, {
    content: mdContent,
    syntaxStyle: style,
    width: '100%',
    renderNode: (token, ctx) => {
      if (token.type === 'table') {
        return createMarkdownTable(token as never, setup.renderer, ctx.syntaxStyle, theme);
      }
      return null;
    },
  });

  setup.renderer.root.add(md);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();

  // Verify borders, cell padding, and alignment
  assert.ok(frame.includes('┌──────'), 'draws top border');
  assert.ok(frame.includes('│ Left '), 'left-aligned header has cell padding');
  assert.ok(frame.includes('│  Mid   │'), 'center-aligned cell padded symmetrically');
  assert.ok(frame.includes('│ 12345 │'), 'right-aligned cell padded on right');
  // Sizing should be content-fit, not 80 chars wide
  assert.ok(!frame.includes('─'.repeat(70)), 'table fits content rather than full terminal width');
  setup.renderer.destroy();
}

// 2. Header-only table (no data rows)
{
  const setup = await createTestRenderer({ width: 80, height: 8, bufferedOutput: 'memory' });
  const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } });

  const mdContent = `
| Column A | Column B |
| -------- | -------- |
`;

  const md = new MarkdownRenderable(setup.renderer, {
    content: mdContent,
    syntaxStyle: style,
    width: '100%',
    renderNode: (token, ctx) => {
      if (token.type === 'table') {
        return createMarkdownTable(token as never, setup.renderer, ctx.syntaxStyle, theme);
      }
      return null;
    },
  });

  setup.renderer.root.add(md);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();

  // In standard OpenTUI, header-only tables fail to render or render blank; custom renderer renders cleanly
  assert.ok(frame.includes('┌──────────┬──────────┐'), 'header-only table has top border');
  assert.ok(frame.includes('│ Column A │ Column B │'), 'header-only table shows headers');
  assert.ok(frame.includes('└──────────┴──────────┘'), 'header-only table has bottom border');
  setup.renderer.destroy();
}

// 3. Multi-line cells with <br>
{
  const setup = await createTestRenderer({ width: 80, height: 10, bufferedOutput: 'memory' });
  const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } });

  const mdContent = `
| Item | Details |
| :--- | :------ |
| Test | Line 1<br>Line 2 |
`;

  const md = new MarkdownRenderable(setup.renderer, {
    content: mdContent,
    syntaxStyle: style,
    width: '100%',
    renderNode: (token, ctx) => {
      if (token.type === 'table') {
        return createMarkdownTable(token as never, setup.renderer, ctx.syntaxStyle, theme);
      }
      return null;
    },
  });

  setup.renderer.root.add(md);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();

  assert.ok(frame.includes('│ Line 1  │'), 'multi-line cell renders first line');
  assert.ok(frame.includes('│ Line 2  │'), 'multi-line cell renders second line');
  setup.renderer.destroy();
}

// 4. In-cell inline styles (bold, italic, code, link)
{
  const setup = await createTestRenderer({ width: 80, height: 12, bufferedOutput: 'memory' });
  const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } });

  const mdContent = `
| Style | Value |
| :--- | :--- |
| Bold | **bold value** |
| Italic | *italic value* |
| Code | \`code value\` |
| Link | [link text](https://example.com) |
`;

  const md = new MarkdownRenderable(setup.renderer, {
    content: mdContent,
    syntaxStyle: style,
    width: '100%',
    renderNode: (token, ctx) => {
      if (token.type === 'table') {
        return createMarkdownTable(token as never, setup.renderer, ctx.syntaxStyle, theme);
      }
      return null;
    },
  });

  setup.renderer.root.add(md);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();

  assert.ok(frame.includes('bold value'), 'renders bold text without raw asterisks');
  assert.ok(!frame.includes('**bold value**'), 'strips bold markdown tokens');
  assert.ok(frame.includes('code value'), 'renders code span');
  assert.ok(!frame.includes('`code value`'), 'strips backticks');
  assert.ok(frame.includes('link text'), 'renders link text');
  assert.ok(!frame.includes('[link text]('), 'conceals markdown link target');
  setup.renderer.destroy();
}

// 5. Direct unit test of createMarkdownTable edge cases
{
  const setup = await createTestRenderer({ width: 80, height: 10, bufferedOutput: 'memory' });
  // Empty header should return null
  assert.equal(createMarkdownTable({ type: 'table', header: [] }, setup.renderer, undefined, theme), null);

  // Fallback text when tokens is empty
  const table = createMarkdownTable(
    {
      type: 'table',
      header: [{ text: 'Col 1' }, { text: 'Col 2' }],
      rows: [[{ text: 'Val 1' }]], // Col 2 is missing in this row
    },
    setup.renderer,
    undefined,
    theme,
  );
  assert.ok(table !== null, 'creates table from text-only cells');
  setup.renderer.root.add(table);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  assert.ok(frame.includes('Col 1'), 'renders Col 1');
  assert.ok(frame.includes('Col 2'), 'renders Col 2');
  assert.ok(frame.includes('Val 1'), 'renders Val 1');
  setup.renderer.destroy();
}

console.log('Markdown table tests passed');
