import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as sdk from '@aily-project/simulator-host-sdk';
import * as hostProtocol from '@aily-project/simulator-protocol/host';
import * as sceneProtocol from '@aily-project/simulator-protocol/scene';
import * as artifactProtocol from '@aily-project/simulator-protocol/artifact';

/** Explicitly called by a supervised Node producer, never on import. The real
 * service, composition, authorities, SDK and file adapter execute; Angular DI
 * and the selected ProjectService/editor/account/Builder are declared fixtures.
 * This does not open the real Blockly UI, compile, write, or start a Runtime. */
export async function runCurrentProjectScopeChecks({ captureRead, capturePin, fixtureRoot,
  hostRoot = 'D:/codes/aily-blockly-unified-host',
  originalEditorRoot = 'D:/codes/aily-coder-editor', ts: suppliedTypeScript }) {
  assert.equal(typeof captureRead, 'function'); assert.equal(typeof capturePin, 'function');
  assert(path.isAbsolute(fixtureRoot));
  const requireEditor = createRequire(path.join(originalEditorRoot, 'package.json'));
  const compilerPath = requireEditor.resolve('typescript'); capturePin(compilerPath);
  const ts = suppliedTypeScript ?? requireEditor('typescript');
  assert.equal(ts.version, '5.9.3');
  const cache = new Map(), consumedSources = [];
  const integration = path.join(hostRoot, 'src/app/integrations/simulator');
  const dispatcher = path.join(hostRoot, 'src/app/services/integrations/subapps/host-provider/subapp-host-provider-dispatcher.ts');
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const bytes = captureRead(filename); consumedSources.push(filename.replaceAll('\\', '/'));
    const compiled = ts.transpileModule(bytes.toString('utf8'), { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, emitDecoratorMetadata: false, useDefineForClassFields: false } });
    assert.equal((compiled.diagnostics ?? []).length, 0, 'Actual service dependency has a syntax diagnostic.');
    const loaded = new Module(filename); loaded.filename = filename; cache.set(filename, loaded);
    loaded.require = name => {
      if (name === '@angular/core') return { Injectable: () => value => value };
      if (name === '@aily-project/simulator-host-sdk') return sdk;
      if (name === '@aily-project/simulator-protocol/host') return hostProtocol;
      if (name === '@aily-project/simulator-protocol/scene') return sceneProtocol;
      if (name === '@aily-project/simulator-protocol/artifact') return artifactProtocol;
      if (name === '@integration/subapps/public-api') return { SubappHostProviderDispatcher: load(dispatcher).SubappHostProviderDispatcher };
      if (name.startsWith('.')) {
        const stem = path.resolve(path.dirname(filename), name).replace(/\.[cm]?js$/u, '');
        return load(stem.endsWith('.ts') ? stem : stem + '.ts');
      }
      throw new Error('Unbound test dependency: ' + name);
    };
    loaded._compile(compiled.outputText, filename); loaded.loaded = true;
    return loaded.exports;
  }
  const { SimulatorHostProviderProductService } = load(path.join(integration, 'simulator-host-provider-product.service.ts'));
  const manifestPath = path.join(fixtureRoot, '.build/aily-artifact-manifest.json');
  const manifest = JSON.parse(captureRead(manifestPath).toString('utf8'));
  const immutableFiles = ['.aily/simulator/scene-network-v2.json', '.build/aily-artifact-manifest.json',
    ...manifest.files.map(file => '.build/' + file.path)].map(name => path.join(fixtureRoot, name));
  function pinFrozen(filename) {
    capturePin(filename);
    const bytes = captureRead(filename);
    return { path: filename.replaceAll('\\', '/'), sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const originalPins = immutableFiles.map(pinFrozen);
  const source = captureRead(path.join(fixtureRoot, '.build/aily-debug-source.txt')).toString('utf8');
  const events = [], scopes = new Set();
  let originalFailure;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  function fixture() {
    const owner = new AbortController(), listeners = new Set();
    let selected = true, current = true, registered = null, blocklyReads = 0, fileReads = 0;
    const captured = Object.freeze({ path: fixtureRoot, projectSessionId: 'scope-test:original-session', signal: owner.signal,
      requireCurrent() { owner.signal.throwIfAborted(); if (!current) throw new Error('Original session generation changed.'); } });
    const project = { currentProjectPath: fixtureRoot, isProjectOpening: false,
      isAilyCodeProject: () => false, captureCurrentProjectActivation: () => selected ? captured : null,
      projectActivation$: { subscribe(listener) { listeners.add(listener); return { unsubscribe() { listeners.delete(listener); } }; } } };
    const bridge = { path: { join: path.join, resolve: path.resolve, relative: path.relative }, fs: {
      existsSync: fs.existsSync,
      async readFileBufferAsync(filename) {
        fileReads++; const bytes = captureRead(filename);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      replaceProjectText() { throw new Error('Frozen fixture writes are forbidden.'); },
      lstatSync(filename) { const value = fs.lstatSync(filename); return { size: value.size, _isFile: value.isFile(), _isSymbolicLink: value.isSymbolicLink() }; },
      realpathAsync: async filename => fs.realpathSync(filename),
    } };
    const service = new SimulatorHostProviderProductService(
      { register(toolId, factory) { assert.equal(toolId, 'simulator'); registered = factory; return () => { registered = null; }; } },
      project,
      { buildActiveBlocklyProject() { throw new Error('No build is authorized in these source checks.'); }, cancelActiveBlocklyProjectBuild() {} },
      { execute() { throw new Error('No Agent action is authorized in these source checks.'); } },
      { resolve() { throw new Error('Hardware intent is outside these checks.'); } },
      { readSnapshot: () => ({ state: 'signed-out', connectivity: 'unknown' }), subscribe: () => ({ close() {} }) },
      { getWorkspaceContentRevision: () => 1, getReusableGeneratedCode() { blocklyReads++; return source; },
        getBlockIdByGeneratedLine: () => null, hasWorkspaceBlock: () => false,
        setDebugExecutionMarker() {}, clearDebugExecutionMarker() {} },
      { refresh() { throw new Error('Debug inspection is outside these checks.'); } },
      { run: action => action() },
    );
    Object.defineProperty(globalThis, 'window', { configurable: true, value: bridge });
    return { service, project, owner, captured, listeners, bridge,
      select(value) { selected = value; },
      announceActivation() { for (const listener of [...listeners]) listener({ reason: 'reload', path: fixtureRoot }); },
      reload() { current = false; this.announceActivation(); },
      registered: () => registered, fileReads: () => fileReads, blocklyReads: () => blocklyReads };
  }
  async function open(value, signal) {
    const scope = await value.service.openCurrentProjectScope(signal);
    if (scope) scopes.add(scope);
    return scope;
  }
  async function check(name, action) { const result = await action(); events.push({ name, status: 'passed', ...result }); }
  try {
    await check('Native-empty-project-keeps-original-empty-provider-session', async () => {
      const value = fixture(); value.select(false);
      assert.equal(await open(value), null); value.service.ensureRegistered();
      let removals = 0;
      const session = await value.registered().open({ toolId: 'simulator', hostInstanceId: 'scope-test:empty',
        transport: { onMessage: () => () => { removals++; }, send() {} } });
      await session.close(); assert.equal(removals, 1); assert.equal(value.fileReads(), 0);
      return { NativeRegistrationReused: true, fileReads: 0 };
    });
    await check('real-composition-reads-frozen-context-Scene-and-normal-Artifact-prefix', async () => {
      const value = fixture(), scope = await open(value), signal = new AbortController().signal;
      assert(scope); scope.requireCurrent();
      assert.equal(scope.activation.path, value.captured.path); assert.equal(scope.activation.projectSessionId, value.captured.projectSessionId);
      const adapter = scope.project; assert(adapter instanceof sdk.SimulatorProjectHostProviderAdapter); assert.equal(scope.project, adapter);
      const context = await scope.callbacks.readContext({ projectIdentity: scope.projectIdentity }, signal);
      const scene = await scope.callbacks.readScene({ projectIdentity: scope.projectIdentity, sceneId: 'main' }, signal);
      assert.equal(context.projectIdentity, scope.projectIdentity); assert.equal(context.activeArtifactRevision, manifest.artifactId);
      assert.equal(scene.projectIdentity, scope.projectIdentity); assert.equal(scene.sceneId, 'main');
      const descriptor = await scope.callbacks.readArtifact({ projectIdentity: scope.projectIdentity, artifactRevision: manifest.artifactId }, signal);
      const member = manifest.files.find(file => file.role === 'elf'); assert(member);
      const chunk = await scope.callbacks.readArtifactChunk({ projectIdentity: scope.projectIdentity,
        artifactReference: descriptor.artifactReference, artifactRevision: descriptor.artifactRevision,
        path: member.path, offsetBytes: 0, maxBytes: 32 }, signal);
      const expected = captureRead(path.join(fixtureRoot, '.build', member.path)).subarray(0, 32);
      assert.deepEqual(Buffer.from(chunk.data), expected);
      await scope.close(); assert.equal(scope.snapshot().closed, true); assert.equal(value.owner.signal.aborted, false);
      return { artifactId: manifest.artifactId, bytes: 32, prefixSha256: createHash('sha256').update(expected).digest('hex'),
        actualSDKAdapter: true, actualCompositionAndAuthority: true, actualProjectService: false };
    });
    await check('same-path-generation-change-during-original-hash-rejects-before-scope-publication', async () => {
      const value = fixture(), opening = value.service.openCurrentProjectScope();
      value.reload(); await assert.rejects(opening, /generation changed/);
      assert.equal(value.fileReads(), 0); assert.equal(value.listeners.size, 0);
      return { fileReads: 0, samePath: true };
    });
    await check('same-path-reload-revokes-opened-scope-without-closing-real-project-owner', async () => {
      const value = fixture(), scope = await open(value); assert(scope);
      value.reload(); assert.equal(scope.activation.signal.aborted, true); assert.throws(() => scope.requireCurrent());
      await scope.close(); assert.equal(scope.snapshot().closed, true); assert.equal(value.listeners.size, 0);
      assert.equal(value.owner.signal.aborted, false);
      return { samePath: true, originalProjectOwnerAborted: false };
    });
    await check('original-activation-event-revokes-before-other-subscribers-update-selected-state', async () => {
      const value = fixture(), scope = await open(value); assert(scope);
      value.announceActivation();
      // The borrowed capture still says current: the event alone must fence it.
      value.captured.requireCurrent(); assert.equal(scope.activation.signal.aborted, true);
      assert.throws(() => scope.requireCurrent()); await scope.close();
      assert.equal(value.owner.signal.aborted, false); assert.equal(value.listeners.size, 0);
      return { activationEventItselfRevoked: true, originalCaptureStateUnchanged: true };
    });
    await check('caller-abort-revokes-only-its-original-product-scope', async () => {
      const value = fixture(), caller = new AbortController(), scope = await open(value, caller.signal); assert(scope);
      caller.abort(); assert.equal(scope.activation.signal.aborted, true); await scope.close();
      assert.equal(value.owner.signal.aborted, false); assert.equal(scope.snapshot().pendingOperations, 0);
      return { originalProjectOwnerAborted: false };
    });
    await check('scope-close-joins-an-actual-file-callback-that-ignores-cancellation', async () => {
      const value = fixture(), scope = await open(value); assert(scope);
      let resolveRead, enteredRead;
      const entered = new Promise(resolve => { enteredRead = resolve; });
      const delayed = new Promise(resolve => { resolveRead = resolve; });
      const originalRead = value.bridge.fs.readFileBufferAsync;
      value.bridge.fs.readFileBufferAsync = filename => filename.endsWith('scene-network-v2.json')
        ? (enteredRead(), delayed) : originalRead(filename);
      const reading = scope.callbacks.readContext({ projectIdentity: scope.projectIdentity }, new AbortController().signal);
      const rejected = assert.rejects(reading);
      await entered; let settled = false;
      const closing = scope.close().then(() => { settled = true; });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(settled, false); assert(scope.snapshot().pendingOperations >= 1);
      resolveRead(new Uint8Array([0]).buffer);
      await rejected; await closing;
      assert.equal(scope.snapshot().pendingOperations, 0); assert.equal(scope.snapshot().closed, true);
      return { originalFileOutcomeJoined: true, originalProjectOwnerAborted: value.owner.signal.aborted };
    });
    await check('failed-original-SDK-cleanup-is-retained-and-retried-on-the-same-scope', async () => {
      const value = fixture(), scope = await open(value); assert(scope);
      const adapter = scope.project, originalClose = adapter.close.bind(adapter); let attempts = 0;
      adapter.close = () => { if (++attempts === 1) throw new Error('Explicit cleanup failure fixture.'); originalClose(); };
      await assert.rejects(scope.close(), /cleanup remains unconfirmed/);
      assert.equal(scope.snapshot().closed, false); assert.equal(scope.snapshot().retainedCleanupSteps, 1);
      assert.throws(() => scope.requireCurrent());
      await scope.close(); assert.equal(attempts, 2); assert.equal(scope.snapshot().closed, true);
      assert.equal(scope.snapshot().retainedCleanupSteps, 0); assert.equal(value.owner.signal.aborted, false);
      return { originalCleanupAttempts: attempts, exactFailedReleaseRetained: true };
    });
    await check('Native-session-retains-failed-product-cleanup-and-retries-without-rebinding', async () => {
      const value = fixture(), originalOpen = value.service.openCurrentProjectScope.bind(value.service);
      let retainedScope, attempts = 0, removals = 0;
      value.service.openCurrentProjectScope = async () => {
        retainedScope = await originalOpen(); assert(retainedScope); scopes.add(retainedScope);
        const adapter = retainedScope.project, originalClose = adapter.close.bind(adapter);
        adapter.close = () => { if (++attempts === 1) throw new Error('Native product cleanup failure fixture.'); originalClose(); };
        return retainedScope;
      };
      value.service.ensureRegistered();
      const session = await value.registered().open({ toolId: 'simulator', hostInstanceId: 'scope-test:native-retry',
        transport: { onMessage: () => () => { removals++; }, send() {} } });
      const firstClose = session.close(); assert.equal(session.close(), firstClose);
      await assert.rejects(firstClose, /session cleanup remains unconfirmed/);
      assert.equal(retainedScope.snapshot().closed, false); assert.equal(removals, 1); assert.equal(attempts, 1);
      await session.close(); await session.close();
      assert.equal(retainedScope.snapshot().closed, true); assert.equal(attempts, 2); assert.equal(removals, 1);
      assert.equal(value.owner.signal.aborted, false);
      return { NativeRegistrationReused: true, originalCleanupAttempts: attempts, transportRemovalCount: removals,
        originalFailedScopeRetried: true, originalProjectOwnerAborted: false };
    });
    const finalPins = immutableFiles.map(pinFrozen); assert.deepEqual(finalPins, originalPins);
    return { events, expectedCases: 9, consumedSources, fixturePins: finalPins, FrozenProjectFilesUnchanged: true,
      actualProductServiceClass: true, actualCompositionAndAuthority: true, actualSDK: true,
      AngularDIExecuted: false, actualProjectService: false, actualBlocklyUI: false,
      normalArtifactCompilations: 0, MCUStarts: 0, WorkerStarts: 0, NodeBusinessACK: false, MainBusinessACK: false };
  } catch (error) { originalFailure = error; throw error; }
  finally {
    const results = await Promise.allSettled([...scopes].map(scope => Promise.resolve().then(() => scope.close())));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    try {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError([...(originalFailure ? [originalFailure] : []), ...failures],
      'Original scope check failure or cleanup remains unconfirmed.');
  }
}
