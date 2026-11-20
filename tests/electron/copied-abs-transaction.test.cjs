'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');

const host = path.resolve(__dirname, '../..');
const requireHost = createRequire(path.join(host, 'package.json'));
const { openProjectSyncStorage } = requireHost('./electron/project-sync-storage');
const { ownerIsDead } = requireHost('./electron/project-file-lock-owner');
const guard = () => {};
const fixture = path.join(host, 'tests/electron/fixtures');


async function verifyRecovery(projectAuthor) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const suite = fs.mkdtempSync(path.join(temp, 'aily-host-copy-prepared-'));
  const kernelFile = path.join(suite, 'kernel.cjs');
  const children = new Set();
  const spawn = args => {
    const child = fork(path.join(fixture, 'r0-publication-worker.cjs'), args, {
      execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  };
  try {
    const kernelModule = path.join(fixture, 'r0-publication-kernel.ts');
    const restart = path.join(host, 'src/app/integrations/blockly/abs/abs-project-restart.ts');
    const alias = path.join(fixture, 'r0-publication-domain-exports.ts');
    requireHost('esbuild').buildSync({ absWorkingDir: host, stdin: {
      contents: `export * from ${JSON.stringify(kernelModule)}; export * from ${JSON.stringify(restart)};`,
      resolveDir: host, loader: 'ts',
    }, bundle: true, platform: 'node', format: 'cjs', outfile: kernelFile, logLevel: 'silent',
    alias: { '@domain/project/public-api': alias, '@domain/project/project-data/public-api': alias } });
    const kernel = require(kernelFile);
    for (const cutoff of ['prepared.json', 'project.abi']) {
      const source = fs.mkdtempSync(path.join(suite, 'source-'));
      const target = path.join(suite, 'destination-' + cutoff.replace('.', '-'));
      const fullCopy = target + '-with-native-marker';
      if (projectAuthor) {
        fs.mkdirSync(path.join(source, '.aily'));
        fs.writeFileSync(path.join(source, '.aily/workspace-mode.json'), '{"version":1,"mode":"project-v1"}');
      }
      const seed = spawn(['fixture', source, kernelFile]);
      assert.equal((await once(seed, 'exit', { signal: AbortSignal.timeout(15000) }))[0], 0);
      if (projectAuthor) {
        const inputFile = path.join(source, 'r0-input.json');
        const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
        input.next.inputAbs += '\n';
        input.next.expected.abs = input.next.inputAbs;
        input.next.authorIntent = 'candidate';
        fs.writeFileSync(inputFile, JSON.stringify(input));
        fs.writeFileSync(path.join(source, 'project.abs'), input.next.inputAbs);
      }
      const origin = spawn(['publish', source, kernelFile, cutoff]);
      const [paused] = await once(origin, 'message', { signal: AbortSignal.timeout(15000) });
      assert.deepEqual({ event: paused.event, label: paused.label }, { event: 'paused', label: cutoff });
      fs.cpSync(source, fullCopy, { recursive: true });
      fs.cpSync(source, target, { recursive: true, filter: sourceFile => path.basename(sourceFile) !== 'project-files.write.lock' });
      const sourcePort = await openProjectSyncStorage(source, guard);
      const targetPort = await openProjectSyncStorage(target, guard);
      const fullPort = await openProjectSyncStorage(fullCopy, guard);
      assert.notDeepEqual(sourcePort.attachment.identity, targetPort.attachment.identity);
      const foreignLock = path.join(fullCopy, '.aily', 'project-files.write.lock');
      const copiedMarker = fs.readFileSync(foreignLock, 'utf8');
      assert.equal(JSON.parse(copiedMarker).pid, paused.pid);
      await assert.rejects(kernel.settleAbsProjectTransaction(fullPort, fullCopy, guard), { code: 'ABS_OPERATION_LOCATION_UNPROVEN' });
      assert.equal(fs.readFileSync(foreignLock, 'utf8'), copiedMarker);
      const oldIsBusy = await openProjectSyncStorage(source, guard, { timeoutMs: 75 });
      await assert.rejects(kernel.settleAbsProjectTransaction(oldIsBusy, source, guard), { code: 'PROJECT_FILE_BUSY' });
      const exited = once(origin, 'exit', { signal: AbortSignal.timeout(15000) });
      assert.ok(origin.kill('SIGKILL'));
      await exited;
      assert.equal(ownerIsDead(JSON.parse(copiedMarker), fullPort.executor), true);
      const getState = async port => Object.fromEntries(await Promise.all([
        'project.abi', 'project.abs', 'project.abs.map.json', 'prepared.json', 'committed.json', 'operation.json',
      ].map(async key => [key, await port.read(key)])));
      const state = await getState(targetPort);
      assert.ok(state['prepared.json']);
      assert.deepEqual(await getState(sourcePort), state);
      const operation = JSON.parse(state['operation.json']);
      const snapshotKey = `recoveries/operation-${operation.id}.json`;
      const originalSnapshot = await sourcePort.read(snapshotKey);
      const ownerScope = { projectKey: source, pageId: 'main' };
      const diagnosis = await new kernel.AbsBaselineStore(targetPort, ownerScope).inspectJournalRecovery();
      assert.equal(diagnosis?.scope.projectKey, source);
      assert.equal(diagnosis.action, cutoff === 'prepared.json' ? 'abandon' : 'recover');
      const mixed = target + '-mixed';
      fs.cpSync(fullCopy, mixed, { recursive: true });
      fs.appendFileSync(path.join(mixed, 'project.abs'), '\n# a competing author\n');
      const mixedPort = await openProjectSyncStorage(mixed, guard);
      const changedState = await getState(mixedPort);
      await assert.rejects(kernel.settleAbsProjectTransaction(mixedPort, mixed, guard), { code: 'ABS_OPERATION_LOCATION_UNPROVEN' });
      assert.deepEqual(await getState(mixedPort), changedState);
      assert.equal(fs.readFileSync(path.join(mixed, '.aily', 'project-files.write.lock'), 'utf8'), copiedMarker);
      for (const [port, project] of [[targetPort, target], [fullPort, fullCopy]]) {
        let output;
        try { output = await kernel.recoverAbsProjectOperation(port, project, guard); }
        catch (error) {
          const lookup = new kernel.AbsBaselineStore(port, { projectKey: project, pageId: 'main' });
          const meta = await lookup.inspectCommitted();
          const now = await getState(port);
          console.error({ cutoff, project, scope: meta?.projection.map.scope, author: meta?.authorSource,
            mode: meta?.workspaceMode, raw: await kernel.hashAbsText(now['project.abs']),
            absEqual: now['project.abs'] === state['project.abs'], abiEqual: now['project.abi'] === state['project.abi'],
            continuation: await lookup.isMetadataOnlyContinuation(state['committed.json'], now['project.abi']) });
          throw error;
        }
        assert.equal((await getState(port))['prepared.json'], null);
        assert.equal((await getState(port))['project.abi'], state['project.abi']);
        if (projectAuthor) assert.equal((await getState(port))['project.abs'], state['project.abs']);
        assert.equal(JSON.parse(await port.read('project.abs.map.json')).scope.projectKey, project);
        assert.equal(await port.read(snapshotKey), originalSnapshot);
        if (cutoff === 'prepared.json') {
          assert.deepEqual(output?.document, JSON.parse(originalSnapshot).document);
          assert.equal(output.candidateApplied, false);
        } else assert.equal(output, null);
      }
      assert.deepEqual(await getState(sourcePort), state);
      const archivedDirectory = path.join(fullCopy, '.aily/abs-sync/recoveries');
      const archivedLock = fs.readdirSync(archivedDirectory).find(name => name.startsWith('copied-lock-'));
      assert.ok(archivedLock);
      assert.equal(fs.readFileSync(path.join(archivedDirectory, archivedLock), 'utf8'), copiedMarker);
      assert.equal(fs.existsSync(foreignLock), false);
      await kernel.settleAbsProjectTransaction(sourcePort, source, guard);
      const sameRoot = await getState(sourcePort);
      assert.equal(sameRoot['prepared.json'], null);
      assert.equal(sameRoot['project.abi'], state['project.abi']);
      const final = JSON.parse(sameRoot['project.abi']).pages[0].content.blocks.blocks[0].fields.VALUE;
      assert.equal(final, cutoff === 'prepared.json' ? 100 : 101);
      console.log(JSON.stringify({ cutoff, projectAuthor, diagnosis: diagnosis.action, copiedRootIsDistinct: true,
        copiedStartup: 'recovered', wholeFolderCopyStartup: 'recovered', originalMarkerArchivedExactly: true,
        liveOwnerProtected: true, mixedBytesAndMarkerPreserved: true,
        sameRootPreparedCleared: true, sameRootProgramValue: final }));
    }
  } finally {
    for (const child of children) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
      child.kill('SIGKILL');
      await exited;
    }
    assert.equal(path.dirname(fs.realpathSync.native(suite)), temp);
    assert.match(path.basename(suite), /^aily-host-copy-prepared-/);
    fs.rmSync(suite, { recursive: true });
  }
}

test('copied interrupted Blockly transactions recover with the original native lock preserved as evidence', async () => {
  await verifyRecovery(false);
});

test('copied interrupted project authoring transactions preserve the exact author ABS', async () => {
  await verifyRecovery(true);
});
