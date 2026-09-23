/** Compile with the production ESM flags to check the installed fork patch. */
import assert from 'node:assert/strict';
import { MarkdownRenderable, RGBA, SyntaxStyle } from '@opentui/core';
import { createTestRenderer, MockTreeSitterClient } from '@opentui/core/testing';

const client = new MockTreeSitterClient();
const setup = await createTestRenderer({ width: 80, height: 12 });
const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } });
try {
  const markdown = new MarkdownRenderable(setup.renderer, {
    treeSitterClient: client, syntaxStyle, content: '# heading\n\n**é漢** and `code`', width: 80,
  });
  setup.renderer.root.add(markdown);
  for (const content of ['# heading\n\n**é漢** and `code`', '# updated\n\n**é漢** and `code`']) {
    markdown.content = content;
    // The controlled highlighter resolves asynchronously; no grammar downloads.
    for (let frame = 0; frame < 8; frame++) {
      await setup.renderOnce();
      client.resolveAllHighlightOnce();
      await Promise.resolve();
    }
    const output = setup.captureCharFrame();
    assert.ok(output.includes(content.includes('updated') ? 'updated' : 'heading'), output);
    assert.ok(output.includes('é漢') && output.includes('code'), output);
  }
} finally {
  setup.renderer.destroy();
  syntaxStyle.destroy();
  await client.destroy();
}
console.log('Compiled Markdown initial and incremental frames are correct.');
