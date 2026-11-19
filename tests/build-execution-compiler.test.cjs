'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const api = require('../child/scripts/build-execution-workspace');
const { killRegisteredProcessTree } = require('../electron/process-tree');

const platform = process.env.AILY_TEST_PLATFORM_ROOT, prefix = process.env.AILY_TEST_BUILDER_PREFIX, board = process.env.AILY_TEST_STM32_BOARD;
test('actual offline STM32 compile continues in a detached execution while an old compiler writes shared outputs',
    { skip: !platform || !prefix || !board, timeout: 240000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-stm32-execution-'))), project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, 'node_modules/@aily-project'), { recursive: true });
    fs.symlinkSync(board, path.join(project, 'node_modules/@aily-project/board-stm32f103c8'), 'junction');
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ type: 'blockly', dependencies: { '@aily-project/board-stm32f103c8': '3.0.0' },
        projectConfig: { pnum: 'BLUEPILL_F103C8', upload_method: 'serialMethod' } }));
    fs.writeFileSync(path.join(project, 'project.abi'), 'preserved document');
    fs.mkdirSync(path.join(project, '.build')); fs.mkdirSync(path.join(project, '.temp'));
    const marker = path.join(project, '.build/aily-workspace.lock'), bytes = JSON.stringify({ schemaVersion: 1, nativeLeaseVersion: 1,
        delegationVersion: 1, delegated: true, pid: 2147483646, token: randomUUID(), operation: 'compile' });
    fs.writeFileSync(marker, bytes);
    const old = spawn(process.execPath, ['-e', `const fs=require('fs'),p=require('path'),r=process.argv[1];
      const timer=setInterval(()=>{fs.writeFileSync(p.join(r,'.build/firmware.bin'),'OLD');fs.writeFileSync(p.join(r,'.temp/preprocess.json'),'OLD');},10);
      process.send('ready');process.on('message',()=>{clearInterval(timer);process.exit(0)});`, project], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const oldClosed = once(old, 'close');
    t.after(async () => { if (old.connected) old.send('stop'); await oldClosed; });
    await once(old, 'message');
    const appData = path.join(root, 'appdata'); fs.mkdirSync(appData);
    const config = api.prepareBuildExecution({ currentProjectPath: project, boardModule: '@aily-project/board-stm32f103c8',
        code: '#include <Arduino.h>\nvoid setup(){pinMode(PC13,OUTPUT);}\nvoid loop(){digitalWrite(PC13,HIGH);delay(10);}',
        projectMacros: [], generatedArtifacts: [], appDataPath: appData, buildRequestId: 'stm32-orphan-recovery' });
    fs.mkdirSync(path.join(config.currentProjectPath, '.temp'), { recursive: true });
    const request = path.join(config.currentProjectPath, '.temp', `compile-request-${randomUUID()}.json`);
    fs.writeFileSync(request, JSON.stringify(config));
    const environment = { ...process.env, PATH: `${prefix}${path.delimiter}${process.env.PATH}`, AILY_APPDATA_PATH: appData,
        AILY_SDK_PATH: path.join(platform, 'sdk'), AILY_TOOLS_PATH: path.join(platform, 'tools'),
        AILY_COMPILERS_PATH: path.join(platform, 'tools'), AILY_REPAIR_READONLY_NPM_PREFIX: prefix, DEV: 'false', AILY_E2E: '0' };
    function launch(input, suffix) {
        fs.mkdirSync(path.join(input.currentProjectPath, '.temp'), { recursive: true });
        const filename = path.join(input.currentProjectPath, '.temp', `compile-request-${randomUUID()}.json`);
        fs.writeFileSync(filename, JSON.stringify(input));
        const logPath = path.join(root, `${suffix}.log`), log = fs.createWriteStream(logPath);
        const child = spawn(process.execPath, [path.resolve(__dirname, '../child/scripts/compile.js'), filename], {
            cwd: input.currentProjectPath, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
        });
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) await killRegisteredProcessTree(child.pid, `owned-stm32-test-cleanup:${suffix}`);
        });
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        const closed = once(child, 'close').then(async result => { await new Promise(resolve => log.end(resolve)); return result; });
        return { child, closed, logPath };
    }
    const first = launch(config, 'compile');
    const [code, signal] = await first.closed;
    const logPath = first.logPath;
    assert.equal(code, 0, `Inspect ${logPath}`); assert.equal(signal, null);
    const selected = api.resolveBuildExecution(project);
    assert.ok(selected, `No completed execution: ${logPath}`);
    assert.equal(selected.buildRequestId, 'stm32-orphan-recovery');
    assert.equal(fs.readFileSync(marker, 'utf8'), bytes);
    assert.equal(fs.readFileSync(path.join(project, 'project.abi'), 'utf8'), 'preserved document');
    assert.notEqual(selected.buildPath, path.join(project, '.build'));
    const bad = api.prepareBuildExecution({ ...config, currentProjectPath: project, buildRequestId: 'stm32-compile-failure',
        code: '#include <Arduino.h>\nvoid setup(){this is invalid C++;}\nvoid loop(){}' });
    const failed = launch(bad, 'failed');
    assert.notEqual((await failed.closed)[0], 0, failed.logPath);
    assert.equal(api.inspectBuildExecution(project, 'stm32-compile-failure').status, 'failed');
    assert.equal(api.resolveBuildExecution(project), null); // No fallback to the earlier success.
    const cancelling = api.prepareBuildExecution({ ...config, currentProjectPath: project, buildRequestId: 'stm32-compile-cancel' });
    const running = launch(cancelling, 'cancelled');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(path.join(cancelling.currentProjectPath, '.build/aily-workspace.lock'))
        || JSON.parse(fs.readFileSync(path.join(cancelling.currentProjectPath, '.build/aily-workspace.lock'), 'utf8')).delegated !== true) {
        if (Date.now() > deadline || running.child.exitCode !== null) throw new Error(`Compiler did not enter its delegated phase: ${running.logPath}`);
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    api.cancelBuildExecution(cancelling);
    assert.equal(await killRegisteredProcessTree(running.child.pid, 'owned-stm32-execution-cancel'), true);
    await running.closed;
    assert.equal(api.inspectBuildExecution(project, 'stm32-compile-cancel').status, 'cancelled');
    assert.equal(api.resolveBuildExecution(project), null);
    assert.equal(fs.readFileSync(marker, 'utf8'), bytes);
    console.log(`STM32 execution evidence: ${root}`);
});
