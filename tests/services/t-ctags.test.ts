import assert from 'node:assert/strict';
import { lookupCtags, parseCtags } from '../../packages/services/navigation/ctags';

const TAGS_FILE = [
  '!_TAG_FILE_FORMAT\t2\t/extended format/',
  '!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted/',
  'main\tsrc/main.ts\tline:10\tf',
  'helper\tsrc/util.ts\t42;"\tf',
  'noline\tsrc/other.ts\t/^const noline = 1;$/;"\tv',
].join('\n');

const records = parseCtags(TAGS_FILE);
assert.equal(records.length, 3, 'T-CTAGS-HEADER-01 !_TAG_ header lines are skipped');
assert.ok(records.every((record) => !record.name.startsWith('!_TAG_')), 'T-CTAGS-HEADER-02 no header pseudo-tag is parsed as a record');

const main = lookupCtags(records, 'main');
assert.equal(main.length, 1, 'T-CTAGS-LOOKUP-01 exact name lookup finds one match');
assert.equal(main[0]?.path, 'src/main.ts');
assert.equal(main[0]?.line, 9, 'T-CTAGS-LINE-01 line:N field is 1-based and converted to a 0-based line');

const helper = lookupCtags(records, 'helper');
assert.equal(helper[0]?.line, 41, 'T-CTAGS-LINE-02 a bare numeric ex-address is decoded as a 1-based line');

const noline = lookupCtags(records, 'noline');
assert.equal(noline[0]?.line, 0, 'T-CTAGS-LINE-03 a search-pattern ex-address with no numeric line defaults to line 0');

assert.equal(lookupCtags(records, 'missing').length, 0, 'T-CTAGS-LOOKUP-02 an absent name has no matches');

// T-CTAGS-CAP-01: a text body over maxBytes is treated as untrustworthy and yields no records.
const oversized = parseCtags(TAGS_FILE, { maxBytes: 10 });
assert.equal(oversized.length, 0, 'T-CTAGS-CAP-01 a file over the byte cap parses to no records');
const withinCap = parseCtags(TAGS_FILE, { maxBytes: 4 * 1024 * 1024 });
assert.equal(withinCap.length, 3, 'T-CTAGS-CAP-02 a file within the cap parses normally');

// Malformed rows (missing fields) are skipped rather than throwing.
const malformed = parseCtags('onlyname\n\nfull\tpath.ts\tline:1');
assert.equal(malformed.length, 1, 'T-CTAGS-MALFORMED-01 rows missing required fields are skipped, not thrown');

console.log('T-CTAGS ctags parsing passed header skip, both address forms, the byte cap and malformed-row handling');
