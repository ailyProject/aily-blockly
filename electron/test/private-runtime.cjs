'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPrivateRuntime } = require('../subapp-private-runtime');
const { CommandManager } = require('../cmd');
const debuggerRoot = process.env.AILY_TEST_DEBUGGER_ROOT || path.resolve(__dirname, '../../../aily-subapp/packages/simulator-debugger');
const entry = process.env.AILY_TEST_DEBUGGER_CLI || path.join(debuggerRoot, 'index.js');
const { connectHostPeer } = require(entry);

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-private-launch-'));
    const manager = new CommandManager();
    const config = { node: process.execPath, entry, args: ['serve', '--runtime-manifest', path.join(root, 'missing.json'), '--evidence-root', path.join(root, 'evidence')],
        credentialEnv: 'AILY_SIMDEBUG_HOST_TOKEN', connect: connectHostPeer };
    const host = { execute: options => manager.executeCommand(options), kill: id => manager.killProcess(id), get: id => manager.getProcess(id) };
    t.after(async () => {
        await manager.killAllProcesses(); assert.equal(manager.getActiveProcessSummaries().length, 0);
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^aily-private-launch-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, manager, config, host };
}

test('supervised serve exposes only public data and stops via private control without forced kill', async t => {
    const f = fixture(t); let killed = 0, secret;
    const runtime = await launchPrivateRuntime(f.config, { ...f.host,
        execute: options => { secret = options.env.AILY_SIMDEBUG_HOST_TOKEN; return f.host.execute(options); },
        kill: id => { killed++; return f.host.kill(id); } });
    t.after(() => runtime.stop());
    assert.doesNotMatch(JSON.stringify(runtime), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(f.manager.getActiveProcessSummaries()), new RegExp(secret));
    const publicPeer = await connectHostPeer(runtime.publicInfo.wsUrl, () => {});
    await assert.rejects(publicPeer.request('runtime.owner.bind', {}), { code: 'RPC_FORBIDDEN' }); publicPeer.close();
    const privatePeer = await runtime.connect(() => {});
    const bindingId = require('node:crypto').randomUUID();
    assert.equal((await privatePeer.request('runtime.owner.bind', { bindingId, ownerSessionId: 'test', manifestPath: path.join(f.root, 'artifact.json') })).bound, true);
    privatePeer.close();
    await runtime.stop(); assert.equal((await runtime.closed).code, 0); assert.equal(killed, 0);
    assert.equal(f.manager.getProcess(runtime.streamId), undefined);
});

for (const mode of ['ready', 'early']) test(`abrupt native parent exit terminates real serve through IPC liveness: ${mode}`, { timeout: 15000 }, async t => {
    const f = fixture(t), { spawn } = require('node:child_process');
    const parent = spawn(process.execPath, [path.join(__dirname, 'fixtures/private-runtime-parent.cjs'), entry, f.root, mode], { windowsHide: true });
    let output = ''; parent.stdout.on('data', data => { output += data; }); parent.stderr.on('data', data => { output += data; });
    t.after(() => { if (parent.exitCode === null) parent.kill(); });
    assert.equal(await new Promise(resolve => parent.once('close', resolve)), 0, output);
    const ready = output.split(/\r?\n/).find(line => line.startsWith('{"event":"parent-fixture"'));
    assert.ok(ready, output); const { pid } = JSON.parse(ready);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    t.after(async () => { if (alive()) await require('../process-tree').killRegisteredProcessTree(pid, 'private-runtime-parent-test'); });
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(alive(), false, 'Runtime survived its native parent');
});

for (const mode of ['timeout', 'cancel', 'invalid-ready', 'early-exit', 'output-limit']) {
    test(`private startup cleans the registered process: ${mode}`, async t => {
        const f = fixture(t), controller = new AbortController();
        const source = mode === 'invalid-ready' ? 'console.log(JSON.stringify({event:"ready",data:{pid:0,url:"http://example.com",wsUrl:"ws://example.com"}}));setInterval(()=>{},1000);'
            : mode === 'early-exit' ? 'process.exit(2);' : mode === 'output-limit' ? 'process.stdout.write("a".repeat(300000));setInterval(()=>{},1000);' : 'setInterval(()=>{},1000);';
        const file = path.join(f.root, 'fixture.cjs'); fs.writeFileSync(file, source);
        let timer;
        if (mode === 'cancel') timer = setTimeout(() => controller.abort(), 100);
        try {
            await assert.rejects(launchPrivateRuntime({ ...f.config, entry: file, timeoutMs: 600, signal: controller.signal }, f.host), {
                code: ({ timeout: 'SUBAPP_START_TIMEOUT', cancel: 'CANCELLED', 'invalid-ready': 'SUBAPP_READY_INVALID', 'early-exit': 'SUBAPP_EXITED', 'output-limit': 'SUBAPP_OUTPUT_LIMIT' })[mode],
            });
        } finally { clearTimeout(timer); }
        assert.equal(f.manager.getActiveProcessSummaries().length, 0);
    });
}
