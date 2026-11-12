'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builderArchiveOptions, compileWithArchiveRecovery } = require('./builder-archive-recovery');

const ice = 'lto1: internal compiler error: bytecode stream: expected tag record_type instead of error_mark';
function fixture(t, first, second = "console.log('firmware compiled');", cacheArgs = ['--generate-archive-cloud-cache']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-archive-recovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'builder.js'), attempts = path.join(root, 'attempts');
    fs.writeFileSync(script, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(process.argv.slice(2))+'\\n');
        if(process.argv.includes('--no-archive-cloud-cache')) { ${second} } else { ${first} }`);
    const messages = [];
    return { root, attempts, messages, run: before => compileWithArchiveRecovery(process.execPath,
        [script, ...cacheArgs], { stdio: ['ignore', 'pipe', 'pipe'] }, before || (() => {}),
        (type, data) => messages.push({ type, data: String(data) })) };
}

test('only isolated Blockly builds with the verified Builder capability enable the new cache', () => {
    const projectPath = path.resolve('project/.aily/build-executions/request/project');
    const logicalProjectPath = path.resolve('project');
    const supported = { execution: { logicalProjectPath }, projectPath, verifiedLocalArchiveCache: true, generateLegacy: true };
    const disabled = { args: ['--no-archive-cloud-cache', '--no-fetch-archive-cloud-cache'] };
    const { args, env } = builderArchiveOptions(supported);
    assert.deepEqual(args, ['--verified-local-archive-cache']);
    assert.deepEqual(JSON.parse(env.AILY_BUILDER_VERIFIED_ARCHIVE_PATH_MAP), { physicalRoot: projectPath, logicalRoot: logicalProjectPath });
    assert.deepEqual(builderArchiveOptions({ ...supported, verifiedLocalArchiveCache: false }), disabled);
    assert.deepEqual(builderArchiveOptions({ ...supported, isAilyCode: true }), disabled);
    assert.deepEqual(builderArchiveOptions({ ...supported, recordsProjectDelivery: true }), disabled);
    assert.deepEqual(builderArchiveOptions({ ...supported, execution: undefined }), { args: ['--generate-archive-cloud-cache'] });
    assert.deepEqual(builderArchiveOptions({ ...supported, execution: undefined, generateLegacy: false }), { args: [] });
});

test('a verified cache retry drops the opt-in before the source compile', async t => {
    const f = fixture(t, `console.error(${JSON.stringify(ice)});process.exitCode=1;`, undefined, ['--verified-local-archive-cache']);
    const result = await f.run();
    assert.equal(result.exitCode, 0);
    assert.equal(result.recoveredArchive, true);
    assert.equal(result.args.includes('--verified-local-archive-cache'), false);
    assert.equal(result.args.includes('--no-archive-cloud-cache'), true);
});

test('changed archive inputs retry from source only for an explicitly verified build', async t => {
    const first = "console.error('[ERROR] Compilation failed: BUILD_ARCHIVE_INPUT_CHANGED: archive input changed');process.exitCode=1;";
    const verified = fixture(t, first, undefined, ['--verified-local-archive-cache']);
    let checks = 0;
    const recovered = await verified.run(() => checks++);
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.archiveRecovery.reason, 'verified-archive-input-changed');
    assert.equal(checks, 1);
    assert.equal(recovered.args.includes('--verified-local-archive-cache'), false);

    const legacy = fixture(t, first);
    const failed = await legacy.run(() => assert.fail('legacy build must not retry this marker'));
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.recoveredArchive, false);
});

test('recompiles an incompatible archive exactly once and retains first diagnostics in the report', async t => {
    const f = fixture(t, `console.error(${JSON.stringify('[ERROR] '+ice)});process.exitCode=1;`);
    let checks = 0;
    const result = await f.run(() => checks++);
    assert.equal(result.exitCode, 0); assert.equal(result.recoveredArchive, true); assert.equal(checks, 1);
    const attempts = fs.readFileSync(f.attempts, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(attempts.length, 2);
    assert.ok(attempts[1].includes('--no-archive-cloud-cache'));
    assert.ok(attempts[1].includes('--no-fetch-archive-cloud-cache'));
    assert.ok(!attempts[1].includes('--generate-archive-cloud-cache'));
    assert.match(result.output.join(''), /internal compiler error/);
    assert.equal(result.archiveRecovery.firstExitCode, 1);
    assert.match(result.archiveRecovery.firstStderr, /internal compiler error/);
    assert.equal(result.archiveRecovery.attempts, 2);
    assert.ok(!f.messages.some(m => m.type === 'stderr'));
    assert.ok(f.messages.some(m => m.data.includes('BUILD_CACHE_RECOVERY')));
});
for (const error of ['project.cpp: error: undeclared name', 'lto1: internal compiler error: unrelated compiler defect']) {
    test(`surfaces ordinary failure without retry: ${error}`, async t => {
        const f = fixture(t, `console.error(${JSON.stringify(error)});process.exitCode=1;`);
        const result = await f.run(() => assert.fail('must not retry'));
        assert.equal(result.exitCode, 1); assert.equal(result.recoveredArchive, false);
        assert.equal(result.archiveRecovery, null);
        assert.equal(fs.readFileSync(f.attempts, 'utf8').trim().split('\n').length, 1);
        assert.equal(f.messages.filter(m => m.type === 'stderr').map(m => m.data).join(''), error+'\n');
    });
}
test('does not retry when the input or workspace check fails', async t => {
    const f = fixture(t, `console.error(${JSON.stringify(ice)});process.exitCode=1;`);
    await assert.rejects(f.run(() => { throw new Error('BUILD_SOURCE_STALE'); }), /BUILD_SOURCE_STALE/);
    assert.equal(fs.readFileSync(f.attempts, 'utf8').trim().split('\n').length, 1);
});
test('retains failure if the source retry also fails', async t => {
    const f = fixture(t, `console.error(${JSON.stringify(ice)});process.exitCode=1;`, "console.error('source error');process.exitCode=2;");
    const result = await f.run();
    assert.equal(result.exitCode, 2); assert.equal(result.recoveredArchive, true);
    assert.ok(f.messages.some(m => m.type === 'stderr' && m.data.includes('source error')));
    assert.equal(fs.readFileSync(f.attempts, 'utf8').trim().split('\n').length, 2);
});
test('does not retry a signalled compiler', async t => {
    const f = fixture(t, `console.error(${JSON.stringify(ice)});process.kill(process.pid,'SIGTERM');`);
    const result = await f.run(() => assert.fail('must not retry cancelled compiler'));
    assert.equal(result.signal, 'SIGTERM'); assert.equal(result.recoveredArchive, false);
});
