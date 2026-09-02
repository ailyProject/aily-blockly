const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.AILY_RG_PATH = process.platform === 'win32'
  ? path.join(__dirname, '..', 'child', 'windows', 'rg.exe')
  : process.platform === 'darwin'
    ? path.join(__dirname, '..', 'child', 'macos', 'rg')
    : path.join(__dirname, '..', 'child', 'rg');

const { searchText, _test } = require('./ripgrep');

test('parses ripgrep byte offsets into UTF-16 source and bounded preview ranges', () => {
  const line = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'src/main.cpp' },
      lines: { text: '中文 c😀c tail\n' },
      line_number: 3,
      submatches: [
        { match: { text: 'c' }, start: 7, end: 8 },
        { match: { text: 'c' }, start: 12, end: 13 },
      ],
    },
  });

  const matches = _test.parseRipgrepJsonMatches(line, 8, 10);

  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map(match => match.sourceRange), [
    { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 4 },
    { startLineNumber: 2, startColumn: 6, endLineNumber: 2, endColumn: 7 },
  ]);
  assert.ok(matches.every(match => !match.previewText.includes('\uFFFD')));
  assert.ok(matches.every(match => match.previewText.length <= 10));
});

test('adds generated-directory and caller glob exclusions to ripgrep arguments', () => {
  const args = [];
  _test.appendSearchScopeArgs(args, {
    includeGlobs: ['**/*.cpp'],
    excludeGlobs: ['**/vendor/**'],
  });

  const joined = args.join('\n');
  assert.match(joined, /!\*\*\/\.build\/\*\*/);
  assert.match(joined, /!\*\*\/\.log\/\*\*/);
  assert.match(joined, /\*\*\/\*\.cpp/);
  assert.match(joined, /!\*\*\/vendor\/\*\*/);
});

test('searchText enforces the global occurrence limit and ignores generated directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-rg-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.build'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'main.cpp'), '中文 c😀c c c c c c\n', 'utf8');
  await fs.writeFile(path.join(root, '.build', 'generated.cpp'), 'c c c c c c\n', 'utf8');

  const result = await searchText({
    path: root,
    pattern: 'c',
    isRegex: false,
    isCaseSensitive: true,
    maxResults: 5,
    maxLineLength: 80,
  });

  assert.equal(result.success, true);
  assert.equal(result.limitHit, true);
  assert.equal(result.matches.length, 5);
  assert.ok(result.matches.every(match => match.file.includes('src/main.cpp')));
  assert.deepEqual(
    result.matches.slice(0, 2).map(match => match.sourceRange.startColumn),
    [3, 6],
  );
});

test('searchText terminates the rg child when a search-on-type query is cancelled', async () => {
  const controller = new AbortController();
  const pending = searchText({
    path: path.join(__dirname, '..'),
    pattern: 'this-pattern-must-not-complete-before-cancellation-0123456789',
    maxResults: 500,
  }, { signal: controller.signal });

  controller.abort();
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.match(result.error, /cancel/i);
});
