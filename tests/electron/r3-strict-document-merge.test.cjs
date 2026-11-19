const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');
const { buildSync } = require('esbuild');
const { createHash } = require('node:crypto');

const repo = path.resolve(__dirname, '../..');
const output = path.join(
  repo,
  'tests/test-results',
  `r3-strict-merge-${Date.now()}`,
);
let kernel;
const clone = (value) => structuredClone(value);
const block = (id, value = 1, rest = {}) => ({
  type: 'merge_test',
  id,
  fields: { VALUE: value },
  ...rest,
});
const workspace = (...blocks) => ({ blocks: { languageVersion: 0, blocks } });
const document = (
  one = workspace(block('a')),
  two = workspace(block('b')),
) => ({
  schemaVersion: 3,
  activePageId: 'one',
  openedPageIds: ['one', 'two'],
  pages: [
    { id: 'one', title: 'One', content: one },
    { id: 'two', title: 'Two', content: two },
  ],
  sharedModel: { variables: [], procedureBlocks: [] },
  extension: { opaque: ['retain'] },
});
const root = (value, id) => value.blocks.blocks.find((item) => item.id === id);
const conflict = (callback) =>
  assert.throws(callback, { code: 'ABS_DOCUMENT_MERGE_CONFLICT' });
const historyConflict = (callback) =>
  assert.throws(callback, { code: 'ABS_HISTORY_DOCUMENT_CONFLICT' });

before(() => {
  fs.mkdirSync(output, { recursive: true });
  const files = ['abs-request-merge.ts', 'abs-history-document.ts'];
  const snapshot = Object.fromEntries(
    files.map((name) => {
      const bytes = fs.readFileSync(
        path.join(repo, 'src/app/integrations/blockly/abs', name),
      );
      fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx' });
      return [name, createHash('sha256').update(bytes).digest('hex')];
    }),
  );
  fs.writeFileSync(
    path.join(output, 'source-snapshot.json'),
    JSON.stringify(snapshot, null, 2),
  );
  const bundle = path.join(output, 'kernel.cjs');
  buildSync({
    absWorkingDir: repo,
    stdin: {
      contents:
        "export * from './src/app/integrations/blockly/abs/abs-request-merge';\nexport * from './src/app/integrations/blockly/abs/abs-history-document';\nexport * from './src/app/integrations/blockly/abs/abs-strict-document-merge';",
      resolveDir: repo,
      sourcefile: 'r3-merge-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundle,
    alias: {
      '@domain/project/project-data/public-api': path.join(
        __dirname,
        'fixtures/r0-publication-domain-exports.ts',
      ),
    },
    logLevel: 'silent',
  });
  kernel = require(bundle);
  console.log(`R3_ARTIFACTS ${output}`);
});

test('different values for the same stable-ID field conflict instead of target winning', () => {
  const base = workspace(block('a', 1)),
    current = workspace(block('a', 2)),
    target = workspace(block('a', 3));
  conflict(() => kernel.mergeAbsRequestWorkspace(base, current, target));
  assert.equal(root(current, 'a').fields.VALUE, 2);
  assert.equal(root(target, 'a').fields.VALUE, 3);
});

test('same-value edits are idempotent and unrelated current fields and opaque state survive', () => {
  const base = workspace(
    block('a', 1, {
      fields: { VALUE: 1, OTHER: 10 },
      extraState: { hidden: ['a'] },
    }),
  );
  const current = clone(base),
    target = clone(base);
  current.blocks.blocks[0].fields = { VALUE: 2, OTHER: 11 };
  target.blocks.blocks[0].fields.VALUE = 2;
  current.blocks.blocks[0].comment = { text: 'new comment', pinned: true };
  const merged = kernel.mergeAbsRequestWorkspace(base, current, target);
  assert.deepEqual(merged, current);
});

test('a current deletion and candidate edit conflict without resurrecting the deleted path', () => {
  const base = workspace(
    block('a', 1, { inputs: { VALUE: { block: block('child') } } }),
  );
  const current = workspace(),
    target = clone(base);
  target.blocks.blocks[0].inputs.VALUE.block.fields.VALUE = 2;
  conflict(() => kernel.mergeAbsRequestWorkspace(base, current, target));
  assert.deepEqual(current, workspace());
});

test('candidate deletion cannot discard a newer current node edit', () => {
  const base = workspace(block('a')),
    current = workspace(block('a', 2)),
    target = workspace();
  conflict(() => kernel.mergeAbsRequestWorkspace(base, current, target));
});

test('a field delta follows its stable ID through an unrelated disconnect instead of restoring the old edge', () => {
  const base = workspace(
    block('parent', 0, { inputs: { VALUE: { block: block('child') } } }),
  );
  const current = workspace(block('parent', 0), block('child'));
  const target = clone(base);
  target.blocks.blocks[0].inputs.VALUE.block.fields.VALUE = 2;
  const merged = kernel.mergeAbsRequestWorkspace(base, current, target);
  assert.equal(root(merged, 'parent').inputs?.VALUE?.block, undefined);
  assert.equal(root(merged, 'child').fields.VALUE, 2);
});

test('a reparent and a payload edit merge across different roots without duplicating the block', () => {
  const base = workspace(
    block('left', 0, { inputs: { VALUE: { block: block('child') } } }),
    block('right', 0),
  );
  const current = workspace(
    block('left', 0),
    block('right', 0, { inputs: { VALUE: { block: block('child') } } }),
  );
  const target = clone(base);
  target.blocks.blocks[0].inputs.VALUE.block.fields.VALUE = 9;
  const merged = kernel.mergeAbsRequestWorkspace(base, current, target);
  assert.equal(root(merged, 'left').inputs?.VALUE?.block, undefined);
  assert.equal(root(merged, 'right').inputs.VALUE.block.id, 'child');
  assert.equal(root(merged, 'right').inputs.VALUE.block.fields.VALUE, 9);
});

test('two different replacements of the same input slot conflict and do not turn the loser into a loose root', () => {
  const base = workspace(
    block('p', 0, { inputs: { VALUE: { block: block('old') } } }),
  );
  const current = workspace(
    block('p', 0, { inputs: { VALUE: { block: block('user') } } }),
  );
  const target = workspace(
    block('p', 0, { inputs: { VALUE: { block: block('agent') } } }),
  );
  conflict(() => kernel.mergeAbsRequestWorkspace(base, current, target));
});

test('independent live child and dormant shadow payload deltas preserve the exact slot metadata', () => {
  const base = workspace(
    block('p', 0, {
      inputs: {
        VALUE: {
          block: block('child'),
          shadow: block('shadow', 5, {
            shadow: true,
            extraState: { hidden: 7 },
          }),
          extension: { tag: 'keep' },
        },
      },
    }),
  );
  const current = clone(base),
    target = clone(base);
  current.blocks.blocks[0].inputs.VALUE.shadow.fields.VALUE = 6;
  target.blocks.blocks[0].inputs.VALUE.block.fields.VALUE = 2;
  const merged = kernel.mergeAbsRequestWorkspace(base, current, target);
  const slot = root(merged, 'p').inputs.VALUE;
  assert.equal(slot.block.fields.VALUE, 2);
  assert.equal(slot.shadow.fields.VALUE, 6);
  assert.deepEqual(slot.extension, { tag: 'keep' });
  assert.deepEqual(slot.shadow.extraState, { hidden: 7 });
});

test('overlapping opaque extraState objects are atomic conflicts, not speculative merged mutations', () => {
  const base = workspace(
    block('a', 1, { extraState: { first: 1, second: 1 } }),
  );
  const current = clone(base),
    target = clone(base);
  current.blocks.blocks[0].extraState.first = 2;
  target.blocks.blocks[0].extraState.second = 2;
  conflict(() => kernel.mergeAbsRequestWorkspace(base, current, target));
});

test('different current and candidate root order changes conflict', () => {
  const a = block('a'),
    b = block('b'),
    c = block('c');
  conflict(() =>
    kernel.mergeAbsRequestWorkspace(
      workspace(a, b, c),
      workspace(b, a, c),
      workspace(a, c, b),
    ),
  );
});

test('duplicate and multiply connected identities are rejected even on an equal-input fast path', () => {
  const duplicate = workspace(block('a'), block('a'));
  conflict(() =>
    kernel.mergeAbsRequestWorkspace(duplicate, duplicate, duplicate),
  );
  const child = block('child');
  const multiple = workspace(
    block('left', 0, { inputs: { VALUE: { block: child } } }),
    block('right', 0, { next: { block: clone(child) } }),
  );
  conflict(() => kernel.mergeAbsRequestWorkspace(multiple, multiple, multiple));
});

test('a full-document merge keeps unrelated pages, shared roots, layout, comments, models and unknown metadata', () => {
  const base = document(),
    current = clone(base),
    target = clone(base);
  base.sharedModel.procedureBlocks.push(
    block('procedure', 0, { extraState: { params: [], extension: 'keep' } }),
  );
  current.sharedModel = clone(base.sharedModel);
  target.sharedModel = clone(base.sharedModel);
  current.pages[1].content.blocks.blocks[0].fields.VALUE = 7;
  current.pages[0].content.blocks.blocks[0].x = 100;
  current.pages[0].viewState = { scale: 2, scrollX: 7, scrollY: 9 };
  target.pages[0].content.blocks.blocks[0].fields.VALUE = 3;
  const merged = kernel.mergeAbsHistoryDocument(base, current, target);
  assert.equal(merged.pages[0].content.blocks.blocks[0].fields.VALUE, 3);
  assert.equal(merged.pages[1].content.blocks.blocks[0].fields.VALUE, 7);
  assert.equal(merged.pages[0].content.blocks.blocks[0].x, 100);
  assert.deepEqual(merged.pages[0].viewState, current.pages[0].viewState);
  assert.deepEqual(merged.sharedModel, base.sharedModel);
  assert.deepEqual(merged.extension, base.extension);
});

test('deleting a page conflicts with a candidate edit on that page', () => {
  const base = document(),
    current = clone(base),
    target = clone(base);
  current.pages = current.pages.filter((page) => page.id !== 'two');
  current.openedPageIds = ['one'];
  target.pages[1].content.blocks.blocks[0].fields.VALUE = 8;
  historyConflict(() => kernel.mergeAbsHistoryDocument(base, current, target));
});

test('stable-ID field edits follow a current move to another page', () => {
  const base = document(),
    current = clone(base),
    target = clone(base);
  const moved = current.pages[0].content.blocks.blocks.pop();
  current.pages[1].content.blocks.blocks.push(moved);
  target.pages[0].content.blocks.blocks[0].fields.VALUE = 9;
  const merged = kernel.mergeAbsHistoryDocument(base, current, target);
  assert.equal(merged.pages[0].content.blocks.blocks.length, 0);
  assert.equal(
    merged.pages[1].content.blocks.blocks.find((item) => item.id === 'a').fields
      .VALUE,
    9,
  );
});

test('shared model deletion versus an edit conflicts and duplicate model IDs are rejected before fast paths', () => {
  const base = document();
  base.sharedModel.variables = [{ id: 'v', name: 'count', type: '' }];
  const current = clone(base),
    target = clone(base);
  current.sharedModel.variables[0].name = 'new count';
  target.sharedModel.variables = [];
  historyConflict(() => kernel.mergeAbsHistoryDocument(base, current, target));
  const duplicate = clone(base);
  duplicate.sharedModel.variables.push(
    clone(duplicate.sharedModel.variables[0]),
  );
  historyConflict(() =>
    kernel.mergeAbsHistoryDocument(duplicate, duplicate, duplicate),
  );
});

test('opaque metadata with ID-like entries is not treated as a model table', () => {
  const base = document();
  base.extension = { records: [{ id: 'same', a: 1, b: 1 }] };
  const current = clone(base),
    target = clone(base);
  current.extension.records[0].a = 2;
  target.extension.records[0].b = 2;
  historyConflict(() => kernel.mergeAbsHistoryDocument(base, current, target));
});

test('global page/shared block identity and page-selection integrity are checked on identical documents', () => {
  const duplicate = document();
  duplicate.sharedModel.procedureBlocks.push(block('a'));
  historyConflict(() =>
    kernel.mergeAbsHistoryDocument(duplicate, duplicate, duplicate),
  );
  const absent = document();
  absent.activePageId = 'missing';
  historyConflict(() => kernel.mergeAbsHistoryDocument(absent, absent, absent));
});

test('prototype-like IDs remain ordinary identities and merge never mutates its three input versions', () => {
  const base = workspace(block('__proto__'), block('constructor')),
    current = clone(base),
    target = clone(base);
  current.blocks.blocks[1].comment = 'new';
  target.blocks.blocks[0].fields.VALUE = 4;
  const before = [base, current, target].map((value) => JSON.stringify(value));
  const merged = kernel.mergeAbsRequestWorkspace(base, current, target);
  assert.equal(root(merged, '__proto__').fields.VALUE, 4);
  assert.equal(root(merged, 'constructor').comment, 'new');
  assert.deepEqual(
    [base, current, target].map((value) => JSON.stringify(value)),
    before,
  );
});

test('large independent roots preserve every identity and full payload while applying a small delta', () => {
  const base = workspace(
    ...Array.from({ length: 3000 }, (_, i) => block(`node-${i}`, i)),
  );
  const current = clone(base),
    target = clone(base);
  current.blocks.blocks[2999].comment = 'latest';
  target.blocks.blocks[0].fields.VALUE = -1;
  const merged = kernel.mergeAbsRequestWorkspace(base, current, target);
  assert.equal(merged.blocks.blocks.length, 3000);
  assert.equal(root(merged, 'node-0').fields.VALUE, -1);
  assert.equal(root(merged, 'node-2999').comment, 'latest');
  assert.deepEqual(
    merged.blocks.blocks.map((item) => item.id),
    base.blocks.blocks.map((item) => item.id),
  );
});

test('disjoint additions to previously absent known field and input dictionaries merge', () => {
  const base = workspace({ id: 'p', type: 'merge_test' }),
    current = clone(base),
    target = clone(base);
  current.blocks.blocks[0].fields = { CURRENT: 1 };
  target.blocks.blocks[0].fields = { TARGET: 2 };
  current.blocks.blocks[0].inputs = { FIRST: { block: block('first') } };
  target.blocks.blocks[0].inputs = { SECOND: { block: block('second') } };
  const result = kernel.mergeAbsRequestWorkspace(base, current, target).blocks
    .blocks[0];
  assert.deepEqual(result.fields, { CURRENT: 1, TARGET: 2 });
  assert.equal(result.inputs.FIRST.block.id, 'first');
  assert.equal(result.inputs.SECOND.block.id, 'second');
});

test('individually valid opposing connection deltas cannot merge into a cycle', () => {
  const base = workspace(block('a'), block('b'));
  const current = workspace(block('a', 1, { next: { block: block('b') } }));
  const target = workspace(block('b', 1, { next: { block: block('a') } }));
  conflict(() => kernel.mergeAbsRequestWorkspace(base, current, target));
});

test('a dormant shadow cannot be promoted into a loose root', () => {
  const invalid = workspace(block('shadow', 1, { shadow: true }));
  conflict(() => kernel.mergeAbsRequestWorkspace(invalid, invalid, invalid));
});

test('declared model references on another page prevent deleting their shared model', () => {
  const base = document();
  base.sharedModel.variables = [{ id: 'v', name: 'count', type: 'Number' }];
  const current = clone(base),
    target = clone(base);
  current.pages[1].content.blocks.blocks[0].fields.REF = {
    id: 'v',
    name: 'count',
    type: 'Number',
  };
  target.sharedModel.variables = [];
  const contract = {
    fields: {
      b: {
        REF: {
          type: 'field_variable',
          symbol: {
            kind: 'variable',
            storage: 'variable-state',
            allowedTypes: ['Number'],
          },
        },
      },
    },
  };
  conflict(() =>
    kernel.mergeAbsStrictDocument(base, current, target, {
      referenceContracts: { two: contract },
    }),
  );
  const unchangedModel = kernel.mergeAbsStrictDocument(base, current, base, {
    referenceContracts: { two: contract },
  });
  assert.deepEqual(unchangedModel, current);
});

test('a newly retained procedure call and concurrent definition deletion fail complete contract verification', () => {
  const base = document();
  base.sharedModel.procedureBlocks = [
    block('definition', 0, {
      fields: { NAME: 'run' },
      extraState: { args: [] },
    }),
  ];
  const current = clone(base),
    target = clone(base);
  current.pages[1].content.blocks.blocks.push(
    block('call', 0, { extraState: { name: 'run', args: [] } }),
  );
  target.sharedModel.procedureBlocks = [];
  const contract = {
    fields: {},
    procedures: {
      definition: {
        role: 'definition',
        namePath: '/fields/NAME',
        parametersPath: '/extraState/args',
        parameterNamePath: '',
        returns: false,
      },
      call: {
        role: 'call',
        namePath: '/extraState/name',
        parametersPath: '/extraState/args',
        parameterNamePath: '',
        returns: false,
      },
    },
  };
  conflict(() =>
    kernel.mergeAbsStrictDocument(base, current, target, {
      referenceContracts: { two: contract },
    }),
  );
  assert.equal(
    kernel.mergeAbsStrictDocument(base, current, base, {
      referenceContracts: { two: contract },
    }).sharedModel.procedureBlocks[0].id,
    'definition',
  );
});

test('absent versus native-empty model tables do not reject an unrelated new declared model', () => {
  const base = workspace(block('a')),
    current = clone(base),
    target = clone(base);
  current.variables = [];
  target.variables = [{ id: 'v', name: 'count', type: '' }];
  assert.deepEqual(
    kernel.mergeAbsRequestWorkspace(base, current, target).variables,
    target.variables,
  );
});

test('independent root insertions keep their anchors and newly colliding IDs are not blended', () => {
  const base = workspace(block('a'), block('c'));
  const current = workspace(block('a'), block('b'), block('c'));
  const target = workspace(block('a'), block('d'), block('c'));
  assert.deepEqual(
    kernel
      .mergeAbsRequestWorkspace(base, current, target)
      .blocks.blocks.map((value) => value.id),
    ['a', 'b', 'd', 'c'],
  );
  conflict(() =>
    kernel.mergeAbsRequestWorkspace(
      workspace(),
      workspace(block('collision', 1)),
      workspace(block('collision', 2)),
    ),
  );
});

test('next edges and their unknown slot attributes retain unrelated current changes', () => {
  const base = workspace(
    block('a', 1, {
      next: { block: block('b', 2), extension: { keep: true } },
    }),
  );
  const current = workspace(
    block('a'),
    block('other', 0, { next: { block: block('b', 2) } }),
  );
  const target = clone(base);
  target.blocks.blocks[0].next.block.fields.VALUE = 3;
  const result = kernel.mergeAbsRequestWorkspace(base, current, target);
  assert.equal(root(result, 'a').next, undefined);
  assert.equal(root(result, 'other').next.block.fields.VALUE, 3);
  assert.deepEqual(base.blocks.blocks[0].next.extension, { keep: true });
});

test('a long sequential stack uses stable-ID traversal without recursive merge of its serialized next chain', () => {
  const make = () => {
    let head = block('chain-2047');
    for (let at = 2046; at >= 0; at--)
      head = block(`chain-${at}`, at, { next: { block: head } });
    return workspace(head);
  };
  const base = make(),
    current = make(),
    target = make();
  current.blocks.blocks[0].comment = 'live';
  let tail = target.blocks.blocks[0];
  while (tail.next) tail = tail.next.block;
  tail.fields.VALUE = -1;
  const result = kernel.mergeAbsRequestWorkspace(base, current, target);
  let count = 0,
    cursor = result.blocks.blocks[0];
  while (cursor) {
    count++;
    if (!cursor.next) assert.equal(cursor.fields.VALUE, -1);
    cursor = cursor.next?.block;
  }
  assert.equal(count, 2048);
  assert.equal(result.blocks.blocks[0].comment, 'live');
});

test('own prototype-like field keys are data and absent keys never read an inherited object', () => {
  const base = workspace(block('a')),
    current = clone(base),
    target = clone(base);
  current.blocks.blocks[0].fields.CURRENT = 2;
  target.blocks.blocks[0].fields = JSON.parse(
    '{"VALUE":1,"__proto__":"persist","constructor":"data"}',
  );
  const fields = kernel.mergeAbsRequestWorkspace(base, current, target).blocks
    .blocks[0].fields;
  assert.equal(Object.hasOwn(fields, '__proto__'), true);
  assert.equal(fields.__proto__, 'persist');
  assert.equal(fields.constructor, 'data');
  assert.equal(fields.CURRENT, 2);
  assert.equal(Object.getPrototypeOf(fields), Object.prototype);
});
