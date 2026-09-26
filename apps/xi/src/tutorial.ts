export const tutorial = `Xi tutorial — edit this buffer to practise!

Launch a fresh copy any time with: xi --tutor
This is an unsaved practice buffer. :q! exits without saving.
Xi uses Vim commands plus multiple selections. Escape returns to Normal mode.
The keys below describe the default configuration; your keymaps may override them.

1. MOVE AND EDIT

Use h j k l (left, down, up, right), or the arrow keys.
w moves to the next word; b moves back. 0 goes to the line start, $ to its end.
gg goes to the first line; G goes to the last line.
Type /practice then Enter to find a practice line. n finds the next occurrence.
i enters Insert mode before the cursor; a enters after it; A at the line end.
Type some text, then Escape. u undoes; Ctrl+r redoes.
x deletes a character; dd deletes a line; yy copies a line; p pastes.

practice: move here and change this sentence.

2. INDENTATION AND SYMBOLS

In Normal mode, > indents the current line; < removes one indent level.
Select several lines with V and j, then > or < to indent the selection.
In Insert mode, Tab indents the whole current line, Shift+Tab unindents it.
Indent width follows the language configuration and .editorconfig.
Completion menus and snippets may take Tab while they are active; Escape closes a menu.
In Insert mode, < and > type literal symbols. Try writing <tag> below.

practice: indent this line, then unindent it.
practice: type <tag> here.

3. MULTIPLE CURSORS ON NEIGHBOURING LINES

Move to the start of the first practice line below with 0.
Alt+Down adds a cursor below; press it again to add the third line.
Alt+Up adds above. The newest cursor becomes primary.
Type i, type a prefix, then Escape. All three lines receive the text together.
Use u to undo the edit. Alt+o keeps just the primary selection.
The status line shows the selection count.

practice: first line
practice: second line
practice: third line

4. SELECT REPEATED WORDS AND CHANGE THEM TOGETHER

Move onto a berry below. Alt+n first selects the word under the cursor.
Press Alt+n again to add the next match; repeat to add another.
Alt+s skips the next match. Alt+a selects all matches of that word.
Type c to change the selected words, type grape, then Escape.
Use u to undo. Alt+o returns to one selection.

berry apple berry orange berry

For an explicit pattern, type :Xi selection.select-all-matches berry then Enter.
:Xi selection.collapse turns those ranges into cursors.
Now i inserts at every cursor. Escape ends insertion; Alt+o keeps one cursor.
:Xi selection.undo undoes a selection change (u undoes text changes).

5. DISCOVER COMMANDS AND CONFIGURE KEYS

In Normal mode, Space x opens the multiple-selection command menu:
a adds above, b below, n next match, s skips, m selects all matches,
l splits into lines, o keeps primary, u undoes the selection change.
Space ; opens the command palette. Space f opens the file picker.
Space c opens your config; :Xi config.reload reloads it after saving.
Bindings live under [keys.normal], [keys.select], and [keys.insert].
Example: "A-n" = "selection.add-next-match"

:w filename saves this practice buffer to a new file.
:q! leaves the tutorial. Run xi --tutor to start fresh.
`;
