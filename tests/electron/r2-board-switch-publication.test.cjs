const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { transformSync, buildSync } = require('esbuild');
const crypto = require('node:crypto');
const helperModule = { exports: {} };
vm.runInNewContext(buildSync({ entryPoints: ['src/app/services/domains/project/project-board-publication-request.ts'], bundle: true,
  write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text, { module: helperModule, exports: helperModule.exports, crypto, Error });

const moduleValue = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync('src/app/integrations/blockly/board-switch-operation.ts', 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: moduleValue, exports: moduleValue.exports, Error });
const { switchProjectBoard } = moduleValue.exports;
const sourceFile = ts.createSourceFile('project.service.ts', fs.readFileSync('src/app/services/domains/project/project.service.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = sourceFile.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProjectService');
const method = declaration.members.find(node => node.name?.getText(sourceFile) === 'changeBoard'); assert.ok(method);
const domainCode = transformSync(`class Domain { ${method.getText(sourceFile)} }; module.exports = Domain;`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
// The small native outcome shape observed on real board publication. This is
// a propagation contract fixture, not a claim that this test creates a commit.
const binding = { generation: 'original-generation', scope: { projectKey: '/owned-project', pageId: 'main' },
  abiHash: 'sha256:' + '1'.repeat(64), absHash: 'sha256:' + '2'.repeat(64), mapHash: 'sha256:' + '3'.repeat(64) };
const original = { projectSaved: true, generatedCodePublished: true, partial: false,
  publication: { status: 'COMMITTED', generation: binding.generation, abiSaved: true, absMirrored: true, mapPublished: true },
  requiresReload: false, evidence: { binding, absBytes: 2839 }, warnings: [], generation: binding.generation,
  projectionReceipt: { version: 2, requestId: 'pub2-00000000-0000-4000-8000-000000000001', base: binding,
    output: { binding, absBytes: 2839 }, persisted: true, validation: { ok: true, scope: 'generation-projection' } },
  absPersistence: { verified: true, originalPublicationVerified: true },
  finalValidation: { ok: true, scope: 'complete-source-publication', originalPublicationVerified: true },
  environment: { version: 1, requestId: 'original-environment', status: 'completed', current: true, candidateApplied: false } };
const target = '@aily-project/board-r2-next';
function port(outcome = original) {
  let board = '@aily-project/board-old', mutations = 0;
  return { currentProject: () => '/owned-project', resolveBoard: async name => ({ name, version: '1.0.0' }),
    readBoard: async () => ({ ok: true, boardPackage: board }), changeBoard: async () => { mutations++; board = target; return outcome; },
    ensureRuntime: async () => {}, isReady: () => true, mutations: () => mutations, select: name => { board = name; } };
}

test('board switch forwards the original native publication identity and small facts without projecting/saving a second time', async () => {
  const actual = { ...original, abs: 'must not leak the full ABS', recipes: { huge: true } }, subject = port(actual);
  const result = await switchProjectBoard({ boardName: target }, subject);
  assert.equal(result.ok, true); assert.equal(result.operation, 'board_switch'); assert.equal(subject.mutations(), 1);
  assert.equal(result.projectionReceipt, actual.projectionReceipt); assert.equal(result.evidence, actual.evidence);
  assert.equal(result.projectionReceipt.requestId, original.projectionReceipt.requestId);
  assert.equal(result.environment, actual.environment); assert.equal(result.publication, actual.publication);
  assert.equal(result.generation, original.generation); assert.equal(result.projectSaved, true);
  assert.equal(Object.hasOwn(result, 'abs'), false); assert.equal(Object.hasOwn(result, 'recipes'), false);
  assert.equal(Object.hasOwn(result, 'saveReceipt'), false, 'A direct native outcome has no durable observation receipt to invent');
});

test('a later runtime failure retains the real committed source facts while remaining an overall failed switch', async () => {
  const subject = port(); subject.ensureRuntime = async () => { throw Error('target runtime not ready'); };
  const result = await switchProjectBoard({ boardName: target }, subject);
  assert.equal(result.ok, false); assert.equal(result.changed, true); assert.equal(result.publication, original.publication);
  assert.equal(result.projectionReceipt, original.projectionReceipt); assert.equal(result.message, 'target runtime not ready');
});

test('a partial original native outcome is retained as failure evidence, never upgraded to ready/source success', async () => {
  const subject = port(); subject.changeBoard = async () => { throw Object.assign(Error('native derived output failed'), { ...original, partial: true }); };
  const result = await switchProjectBoard({ boardName: target }, subject);
  assert.equal(result.ok, false); assert.equal(result.changed, null); assert.equal(result.partial, true);
  assert.equal(result.projectSaved, true); assert.equal(result.publication, original.publication);
  assert.equal(result.projectionReceipt, original.projectionReceipt);
});

test('same-board and legacy Coder lifecycle results do not mint native publication facts', async () => {
  const same = port(); same.select(target);
  const result = await switchProjectBoard({ boardName: target }, same);
  assert.equal(result.ok, true); assert.equal(result.changed, false); assert.equal(same.mutations(), 0);
  assert.equal(Object.hasOwn(result, 'projectionReceipt'), false);
  const legacy = port(undefined); legacy.changeBoard = async () => { legacy.select(target); };
  const coder = await switchProjectBoard({ boardName: target }, legacy);
  assert.equal(coder.ok, true); assert.equal(Object.hasOwn(coder, 'projectionReceipt'), false);
});

test('a hidden same-board request seals its original save without rerunning board change or inventing environment completion', async () => {
  const subject = port(); subject.select(target); let saves = 0;
  const { environment: _unrelated, ...unchanged } = original;
  subject.saveUnchanged = async () => { saves++; return unchanged; };
  const result = await switchProjectBoard({ boardName: target }, subject);
  assert.equal(result.ok, true); assert.equal(result.changed, false); assert.equal(saves, 1); assert.equal(subject.mutations(), 0);
  assert.equal(result.projectionReceipt, original.projectionReceipt); assert.equal(Object.hasOwn(result, 'environment'), false);
});

test('the actual Domain board path returns its one original native outcome rather than discarding it', async t => {
  const base = path.resolve('tests/test-results/r2-board-switch'), suite = fs.mkdtempSync((fs.mkdirSync(base, { recursive: true }), path.join(base, 'owned-')));
  t.after(() => { assert.ok(suite.startsWith(base + path.sep)); fs.rmSync(suite, { recursive: true, force: true }); });
  const appData = path.join(suite, 'appdata'), template = path.join(appData, 'node_modules', target, 'template'); fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({ dependencies: { [target]: '1.0.0' } }));
  const subjectModule = { exports: {} }, publications = []; let admitted = false, downloads = 0;
  vm.runInNewContext(domainCode, { module: subjectModule, exports: subjectModule.exports, console: { log() {}, error() {} },
    window: { fs, path: { ...path, getAppDataPath: () => appData } }, normalizeProjectMode: () => 'arduino',
    isBoardCompatibleWithProjectMode: () => true, isAilyBoardPackageName: value => value.startsWith('@aily-project/board-'),
    boardPublicationRequest: helperModule.exports.boardPublicationRequest });
  const subject = Object.assign(new subjectModule.exports(), { currentProjectPath: path.join(suite, 'project'),
    acquireProjectLifecycle: () => ({ token: 'original-owner', release() {} }), platformService: { getPlatformSeparator: () => path.sep },
    getPackageJson: async () => ({ name: 'retained-project', dependencies: { '@aily-project/board-old': '1', '@aily-project/lib-keep': '1' } }),
    isAilyCodeProject: () => false, normalizeAilyBoardPackageName: value => value,
    configService: { boardDict: { [target]: { name: target, version: '1' } }, recordBoardUsage() {}, getNpmRegistryForBoard: () => undefined },
    message: { loading() {}, success() {}, error() {} }, translate: { instant: value => value },
    getBoardModule: async () => '@aily-project/board-old', buildNpmPackageSpec: name => name,
    buildNpmInstallCommand: async () => 'fixture network-download boundary', cmdService: { runAsyncChecked: async () => {
      assert.equal(admitted, true, 'The original native admission must precede target cache/download preparation'); downloads++;
    } },
    application: { updateFooterState() {} }, boardChangeSubject: { next() {} }, rejectBoardSwitchReload() {},
    publishManifestEnvironment: async (factory, operation, request) => {
      assert.equal(typeof factory, 'function'); assert.equal(downloads, 0); assert.equal(request.input.boardName, target);
      admitted = true; const manifest = await factory(); publications.push({ manifest, operation, request }); return original;
    } });
  const result = await subject.changeBoard({ name: target, version: '1' });
  assert.equal(result, original); assert.equal(publications.length, 1); assert.equal(publications[0].operation, 'board-switch');
  assert.equal(publications[0].manifest.dependencies['@aily-project/lib-keep'], '1');
  assert.equal(downloads, 1);
  // The real kernel's existing-ID branch returns before invoking this factory.
  // Its durable dedupe is tested by r2-board-request-input.test.cjs.
  subject.publishManifestEnvironment = async (_factory, _operation, request) => {
    assert.equal(request.requestId, publications[0].request.requestId); return original;
  };
  await subject.changeBoard({ name: target, version: '1' }, publications[0].request);
  assert.equal(downloads, 1, 'A retained original request must not prepare a target twice');
});
