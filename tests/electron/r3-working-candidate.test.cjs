const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, 'tests/test-results', `r3-working-candidate-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'abs-working-candidate-source.ts'),
  fs.readFileSync(path.join(repo, 'src/app/integrations/blockly/abs/abs-working-candidate.ts')), { flag: 'wx' });
const bundle = path.join(output, 'candidate.cjs');
buildSync({ absWorkingDir: repo, stdin: {
  contents: "export * from './src/app/integrations/blockly/abs/abs-working-candidate';\nexport {createAbsProjection,absJson} from './src/app/integrations/blockly/abs/abs-identity-map';\nexport {composeBlocklyPage} from './src/app/editors/blockly-editor/services/blockly-project-model';\nexport {mergeAbsStrictDocument} from './src/app/integrations/blockly/abs/abs-strict-document-merge';",
  resolveDir: repo, sourcefile: 'r3-working-candidate-entry.ts', loader: 'ts',
}, bundle: true,
  platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent', alias: {
    '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
    '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
  } });
const kernel = require(bundle);
console.log(`R3_ARTIFACTS ${output}`);
const sha = value => createHash('sha256').update(value).digest('hex');
const ref = value => ({ hash: sha(value), bytes: Buffer.byteLength(value) });
const clone = value => structuredClone(value);
const candidateId = '11111111-1111-4111-8111-111111111111';
const document = (c = 201) => ({
  schemaVersion: 3, activePageId: 'one', openedPageIds: ['one', 'two'],
  pages: [
    { id: 'one', title: 'Working page', viewState: { scale: 1.5, scrollX: 7, scrollY: 9 }, content: {
      blocks: { languageVersion: 0, blocks: [
        { id: 'a', type: 'merge_number', fields: { NUM: 100 }, extraState: { opaque: ['keep', { id: 'not-a-model' }] } },
        { id: 'gui-c', type: 'merge_number', fields: { NUM: c }, collapsed: true, comment: { text: '😀 GUI C', pinned: true }, data: 'hidden' },
      ] },
    } },
    { id: 'two', title: 'Untouched page', content: { blocks: { blocks: [
      { id: 'inactive', type: 'merge_number', fields: { NUM: 300 }, extension: { untouched: 'opaque' } },
    ] }, opaqueSerializer: { raw: ['retain', { unknown: 'metadata' }] } } },
  ],
  sharedModel: { variables: [{ id: 'unused-v', name: 'same display', type: '' }], procedureBlocks: [], extension: { unknown: true } },
  extension: { unknown: ['whole document preserved'] },
});
const contracts = { fields: {
  a: { NUM: { type: 'field_number' } }, 'gui-c': { NUM: { type: 'field_number' } },
} };

async function fixture() {
  const project = fs.mkdtempSync(path.join(output, 'project-'));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"r3-candidate","type":"blockly"}');
  const physical = fs.realpathSync.native(project), disk = document(200), working = document(201);
  fs.writeFileSync(path.join(project, 'project.abi'), kernel.absJson(disk));
  const port = await openProjectSyncStorage(project, () => {});
  const scope = { projectKey: physical, pageId: 'one' };
  const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(working, 'one'), {
    generation: 'r3-frozen-working', baselineRef: 'retained-dirty-working', scope,
    savedAbiHash: 'sha256:' + sha(kernel.absJson(disk)), document: working, contracts,
  });
  const reads = [];
  const trackedPort = { ...port, read: async key => { reads.push(key); return port.read(key); } };
  const objectFile = hash => path.join(project, '.workspace-history', 'objects', hash.slice(0, 2), `${hash}.blob`);
  const put = text => {
    const object = ref(text), file = objectFile(object.hash);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, { flag: 'wx' });
    return object;
  };
  const putRecord = record => {
    const object = put(kernel.absJson(record));
    return { version: 1, id: record.id, revisionHash: object.hash };
  };
  const capture = {
    version: 1, kind: 'agent', id: candidateId,
    owner: { sessionId: 'original-session', intentAnchorId: 'original-intent' },
    project: { logicalId: sha(physical), attachment: port.attachment },
    scope: { kind: 'pages', pageIds: ['one'] },
    base: { document: put(kernel.absJson(projection.document)), abs: put(projection.abs),
      map: put(kernel.absJson(projection.map)), contracts: put(kernel.absJson(projection.contracts)), published: null },
    source: put(projection.abs), derivation: { kind: 'capture' }, intent: { anchorId: 'original-intent' },
  };
  const captured = putRecord(capture);
  const revision = (parent, source, derivation, overrides = {}) => {
    const record = { ...clone(capture), parent: clone(parent), source: put(source), derivation, ...overrides };
    return { record, ref: putRecord(record), source };
  };
  const edit = (parent = captured, source = projection.abs, value = '101') => {
    const match = /merge_number\((?:NUM=)?100\)/.exec(source);
    assert.ok(match, 'fixture must edit the actual rendered ABS literal');
    const start = match.index + match[0].indexOf('100'), edits = [{ start, end: start + 3, text: value }];
    const after = source.slice(0, start) + value + source.slice(start + 3);
    return revision(parent, after, { kind: 'splices', edits: put(kernel.absJson(edits)) });
  };
  return { project, physical, disk, working, port: trackedPort, scope, projection, capture, captured,
    put, putRecord, objectFile, revision, edit, reads };
}

test('actual projection freezes complete dirty Working C rather than reading the older disk document', async () => {
  const f = await fixture(), changed = f.edit();
  f.working.pages[0].content.blocks.blocks[1].fields.NUM = 999;
  const actual = await kernel.readWorkingCandidate(changed.ref, f.port, f.scope, changed.source);
  assert.equal(actual.baseline.document.pages[0].content.blocks.blocks[1].fields.NUM, 201);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.project, 'project.abi'), 'utf8')).pages[0].content.blocks.blocks[1].fields.NUM, 200);
  assert.deepEqual(actual.baseline.document.pages[1], document().pages[1]);
  assert.deepEqual(actual.baseline.document.sharedModel, document().sharedModel);
  assert.deepEqual(actual.baseline.document.extension, document().extension);
  assert.deepEqual(actual.sourceEdits, kernel.composeCandidateSplices(f.projection.abs,
    [JSON.parse(await f.port.read(`history-objects/${changed.record.derivation.edits.hash}`))], changed.source));
  assert.ok(f.reads.every(key => /^history-objects\/[a-f0-9]{64}$/.test(key)));
});

test('exact old revision is read when unrelated new head data exists, without selecting any head', async () => {
  const f = await fixture(), old = f.edit(), newer = f.revision(old.ref, 'unresolved latest(', { kind: 'replace', mapping: 'unresolved' });
  f.reads.length = 0;
  const read = await kernel.readWorkingCandidate(old.ref, f.port, f.scope, old.source);
  assert.deepEqual(read.ref, old.ref); assert.notEqual(read.ref.revisionHash, newer.ref.revisionHash);
  assert.equal(f.reads.includes(`history-objects/${newer.ref.revisionHash}`), false);
  assert.ok(f.reads.every(key => /^history-objects\/[a-f0-9]{64}$/.test(key)));
});

test('physical attachment and logical workspace identity are both required, not matching source text', async () => {
  const f = await fixture(), foreign = clone(f.capture);
  foreign.project.attachment.identity.ino = String(BigInt(foreign.project.attachment.identity.ino) + 1n);
  await assert.rejects(kernel.readWorkingCandidate(f.putRecord(foreign), f.port, f.scope, f.projection.abs), { code: 'ABS_CANDIDATE_ATTACHMENT_STALE' });
  const wrongLogical = clone(f.capture); wrongLogical.project.logicalId = 'a'.repeat(64);
  await assert.rejects(kernel.readWorkingCandidate(f.putRecord(wrongLogical), f.port, f.scope, f.projection.abs), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
});

test('parent owner, intent, base and parent candidate ID cannot drift inside an immutable ancestry', async () => {
  const f = await fixture(), edited = f.edit();
  for (const update of [
    record => { record.base.abs = f.put('different immutable base'); },
    record => { record.owner.sessionId = 'another-session'; },
    record => { record.owner.intentAnchorId = 'another-intent'; record.intent.anchorId = 'another-intent'; },
    record => { record.parent.id = '22222222-2222-4222-8222-222222222222'; },
  ]) {
    const bad = clone(edited.record); update(bad);
    await assert.rejects(kernel.readWorkingCandidate(f.putRecord(bad), f.port, f.scope, edited.source), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
  }
});

test('record corruption, source corruption, false lengths and a wrong source argument are rejected', async () => {
  const f = await fixture(), edited = f.edit();
  await assert.rejects(kernel.readWorkingCandidate(edited.ref, f.port, f.scope, edited.source + 'changed'), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
  const badLength = clone(edited.record); badLength.source.bytes++;
  await assert.rejects(kernel.readWorkingCandidate(f.putRecord(badLength), f.port, f.scope, edited.source), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
  const sourceFile = f.objectFile(edited.record.source.hash), originalSource = fs.readFileSync(sourceFile);
  fs.writeFileSync(sourceFile, 'corrupt source');
  await assert.rejects(kernel.readWorkingCandidate(edited.ref, f.port, f.scope, edited.source), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
  fs.writeFileSync(sourceFile, originalSource);
  fs.writeFileSync(f.objectFile(edited.ref.revisionHash), '{}');
  await assert.rejects(kernel.readWorkingCandidate(edited.ref, f.port, f.scope, edited.source), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
});

test('scope must include the fixed candidate page and frozen map scope cannot be swapped', async () => {
  const f = await fixture(), wrong = clone(f.capture); wrong.scope.pageIds = ['two'];
  await assert.rejects(kernel.readWorkingCandidate(f.putRecord(wrong), f.port, f.scope, f.projection.abs), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
  const map = clone(f.projection.map); map.scope.pageId = 'two';
  const badMap = clone(f.capture); badMap.base.map = f.put(kernel.absJson(map));
  await assert.rejects(kernel.readWorkingCandidate(f.putRecord(badMap), f.port, f.scope, f.projection.abs), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
});

test('unresolved whole replacements remain readable but never acquire fabricated exact source edits', async () => {
  const f = await fixture(), changed = f.revision(f.captured, 'incomplete source(', { kind: 'replace', mapping: 'unresolved' });
  const appended = changed.source + 'later';
  const next = f.revision(changed.ref, appended, { kind: 'splices', edits: f.put(kernel.absJson([
    { start: changed.source.length, end: changed.source.length, text: 'later' },
  ])) });
  const result = await kernel.readWorkingCandidate(next.ref, f.port, f.scope, appended);
  assert.equal(result.sourceEdits, undefined); assert.equal(result.record.derivation.kind, 'splices');
  assert.deepEqual(result.baseline.document, f.projection.document);
  assert.equal(fs.existsSync(f.objectFile(changed.ref.revisionHash)), true);
});

test('actual immutable ancestry over 128 revisions composes UTF-16 operations without rebinding its base', async () => {
  const f = await fixture(); let parent = f.captured, source = f.projection.abs;
  const offset = source.indexOf('\n'); assert.ok(offset > 0);
  for (let at = 0; at < 140; at++) {
    const text = at % 2 ? 'x' : '😀';
    const next = f.revision(parent, source.slice(0, offset) + text + source.slice(offset),
      { kind: 'splices', edits: f.put(kernel.absJson([{ start: offset, end: offset, text }])) });
    parent = next.ref; source = next.source;
  }
  const actual = await kernel.readWorkingCandidate(parent, f.port, f.scope, source);
  assert.deepEqual(actual.record.base, f.capture.base);
  assert.equal(actual.sourceEdits.length, 1); assert.equal(actual.sourceEdits[0][0].start, offset);
  assert.equal(actual.sourceEdits[0][0].end, offset); assert.equal(actual.sourceEdits[0][0].text.length, 210);
});

test('an explicit fork gets a new candidate and owner while inheriting the exact old frozen base and source', async () => {
  const f = await fixture(), edited = f.edit();
  const fork = { ...clone(edited.record), id: '22222222-2222-4222-8222-222222222222',
    owner: { sessionId: 'new-session', intentAnchorId: 'original-intent' },
    intent: { anchorId: 'original-intent' }, parent: edited.ref, derivation: { kind: 'fork' } };
  const result = await kernel.readWorkingCandidate(f.putRecord(fork), f.port, f.scope, edited.source);
  assert.equal(result.record.id, fork.id); assert.deepEqual(result.record.owner, fork.owner);
  assert.deepEqual(result.record.base, edited.record.base); assert.deepEqual(result.record.project, edited.record.project);
  assert.deepEqual(result.record.scope, edited.record.scope);
  assert.equal(result.record.source.hash, edited.record.source.hash);
  const original = await kernel.readWorkingCandidate(edited.ref, f.port, f.scope, edited.source);
  assert.deepEqual(result.sourceEdits, original.sourceEdits);
  assert.equal(fs.existsSync(f.objectFile(edited.ref.revisionHash)), true);
});

test('fork is not permission to replace source, base or scope, or to relabel a same-ID ancestry', async () => {
  const f = await fixture(), edited = f.edit();
  const valid = { ...clone(edited.record), id: '22222222-2222-4222-8222-222222222222',
    owner: { sessionId: 'new-session', intentAnchorId: 'original-intent' },
    intent: { anchorId: 'original-intent' }, parent: edited.ref, derivation: { kind: 'fork' } };
  for (const change of [
    record => { record.source = f.put(edited.source + 'different'); },
    record => { record.base.abs = f.put('different base'); },
    record => { record.scope = { kind: 'project' }; },
    record => { record.id = candidateId; },
    record => { record.owner.intentAnchorId = 'different-intent'; record.intent.anchorId = 'different-intent'; },
  ]) {
    const bad = clone(valid); change(bad);
    const source = await f.port.read(`history-objects/${bad.source.hash}`);
    await assert.rejects(kernel.readWorkingCandidate(f.putRecord(bad), f.port, f.scope, source), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
  }
});

test('equal-text replacement remains an actual immutable edit relationship in the reader', async () => {
  const f = await fixture(), start = f.projection.abs.indexOf('merge_number'); assert.ok(start > 0);
  const edits = [{ start, end: start + 'merge_number'.length, text: 'merge_number' }];
  const equal = f.revision(f.captured, f.projection.abs, { kind: 'splices', edits: f.put(kernel.absJson(edits)) });
  const actual = await kernel.readWorkingCandidate(equal.ref, f.port, f.scope, equal.source);
  assert.notEqual(equal.ref.revisionHash, f.captured.revisionHash); assert.deepEqual(actual.sourceEdits, [edits]);
});

const suppliedWork = process.env.AILY_R3_ORIGINAL_WORK;
for (const [name, relative] of [
  ['787', 'customer787-20261106/project/replay-input/project.abi'],
  ['chiyao', 'chiyao-baseline-20261106/project/replay-input/chiyao/project.abi'],
]) test(`original ${name} full document retains every opaque byte value and ID under independent known-field deltas`, { skip: !suppliedWork }, () => {
  const file = path.join(suppliedWork, relative), originalBytes = fs.readFileSync(file);
  const base = JSON.parse(originalBytes), detached = value => JSON.parse(kernel.absJson(value));
  assert.equal(base.schemaVersion, 3);
  const index = value => {
    const result = new Map(), pending = [...value.sharedModel.procedureBlocks,
      ...value.pages.flatMap(page => page.content.blocks.blocks)];
    while (pending.length) {
      const block = pending.pop(); assert.equal(result.has(block.id), false); result.set(block.id, block);
      for (const slot of Object.values(block.inputs ?? {})) { if (slot.block) pending.push(slot.block); if (slot.shadow) pending.push(slot.shadow); }
      if (block.next?.block) pending.push(block.next.block);
    }
    return result;
  };
  const all = index(base), fields = [...all.values()].flatMap(block => Object.entries(block.fields ?? {})
    .filter(([field, value]) => field === 'NUM' && ['number', 'string'].includes(typeof value) && value !== '' && Number.isFinite(Number(value)))
    .map(([field, value]) => ({ id: block.id, field, value })));
  assert.ok(fields.length >= 2, 'original complete program needs two explicit numeric field identities');
  const one = fields[0], two = fields.find(value => value.id !== one.id); assert.ok(two);
  const current = detached(base), target = detached(base), expected = detached(base);
  const change = (value, selected, delta) => { index(value).get(selected.id).fields[selected.field] =
    typeof selected.value === 'string' ? String(Number(selected.value) + delta) : selected.value + delta; };
  change(current, one, 1); change(target, two, 2); change(expected, one, 1); change(expected, two, 2);
  const merged = kernel.mergeAbsStrictDocument(base, current, target);
  assert.equal(kernel.absJson(merged), kernel.absJson(expected));
  assert.deepEqual([...index(merged).keys()].sort(), [...all.keys()].sort());
  assert.deepEqual(fs.readFileSync(file), originalBytes);
  console.log(`R3_ORIGINAL_DATA ${JSON.stringify({ name, file, bytes: originalBytes.length, sha256: sha(originalBytes),
    blocks: all.size, edited: [one.id, two.id], nativeAcceptance: false, changedOriginal: false })}`);
});
test('composes more than 128 exact edit batches without rebasing or losing untouched emoji offsets', () => {
  const base = '😀 alpha beta omega';
  const batches = Array.from({ length: 140 }, () => [{ start: 9, end: 9, text: 'x' }]);
  const after = base.slice(0, 9) + 'x'.repeat(140) + base.slice(9);
  assert.deepEqual(kernel.composeCandidateSplices(base, batches, after), [[{ start: 9, end: 9, text: 'x'.repeat(140) }]]);
});
test('replaced identical text is still replaced identity, not guessed from final text diff', () => {
  assert.deepEqual(kernel.composeCandidateSplices('foo(1)', [[{ start: 0, end: 3, text: 'foo' }]], 'foo(1)'),
    [[{ start: 0, end: 3, text: 'foo' }]]);
});
test('same blob in different candidate intents has distinct publication identity', async () => {
  const one = { version: 1, id: '11111111-1111-4111-8111-111111111111', revisionHash: 'a'.repeat(64) };
  const two = { ...one, id: '22222222-2222-4222-8222-222222222222' };
  assert.notEqual(await kernel.workingCandidateKey(one), await kernel.workingCandidateKey(two));
});
test('an exact old ref is read without selecting current head and corrupt blobs are rejected', async () => {
  const body = 'incomplete('; const object = ref(body);
  assert.equal(await kernel.readCandidateObject(object, async hash => hash === object.hash ? body : null), body);
  await assert.rejects(kernel.readCandidateObject(object, async () => 'other'), { code: 'ABS_CANDIDATE_OBJECT_INVALID' });
});

test('single original batch retains the complete tail after a longer right replacement and shorter left replacement', () => {
  const edits = [{ start: 0, end: 1, text: 'X' }, { start: 3, end: 4, text: 'LONG' }];
  assert.deepEqual(kernel.composeCandidateSplices('abcde', [edits], 'XbcLONGe'), [edits]);
});

test('single original batch preserves UTF-16 emoji intervals and equal-text replacement identity', () => {
  const base = '😀 abc def tail';
  const edits = [{ start: 3, end: 6, text: 'abc' }, { start: 7, end: 10, text: 'LONGER' }];
  assert.deepEqual(kernel.composeCandidateSplices(base, [edits], '😀 abc LONGER tail'), [edits]);
});

test('single original batch accepts multiple deletions and shortening replacements without rebasing offsets', () => {
  const edits = [{ start: 1, end: 3, text: '' }, { start: 6, end: 8, text: 'Q' }];
  assert.deepEqual(kernel.composeCandidateSplices('0123456789', [edits], '0345Q89'), [edits]);
});
