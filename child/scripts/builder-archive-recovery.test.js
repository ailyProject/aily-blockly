'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileWithArchiveRecovery } = require('./builder-archive-recovery');

const ice = 'lto1: internal compiler error: bytecode stream: expected tag record_type instead of error_mark';
function fixture(t, first, second = "console.log('firmware compiled');") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-archive-recovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'builder.js'), attempts = path.join(root, 'attempts');
    fs.writeFileSync(script, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(process.argv.slice(2))+'\\n');
        if(process.argv.includes('--no-archive-cloud-cache')) { ${second} } else { ${first} }`);
    const messages = [];
    return { root, attempts, messages, run: before => compileWithArchiveRecovery(process.execPath,
        [script, '--generate-archive-cloud-cache'], { stdio: ['ignore', 'pipe', 'pipe'] }, before || (() => {}),
        (type, data) => messages.push({ type, data: String(data) })) };
}

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
