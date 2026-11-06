'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createSimulatorOwnerCleanupDiagnostics } = require('./simulator-owner-cleanup-diagnostics');
const root = path.resolve(__dirname, '..');
const PREFIX = 'AILY_INTERNAL_CLEANUP_V1 ';
const valid = () => ({ schemaVersion: 1, kind: 'aily-internal-cleanup-observation', source: 'node-network-original-ipc', status: 'submitted' });
const frame = (value = valid(), tail = '\n') => PREFIX + JSON.stringify(value) + tail;
function parse(relative, kind = ts.ScriptKind.TS) {
    const name = path.join(root, relative);
    return ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}
function find(node, predicate) {
    if (predicate(node)) return node;
    let result;
    ts.forEachChild(node, child => { result ??= find(child, predicate); });
    return result;
}
const renderer = parse('src/app/services/integrations/subapps/child-tool-process.service.ts');
const klass = renderer.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ChildToolProcessService');
const names = ['handleProcessOutput', 'log', 'logError', 'tailText', 'stringifyLogDetails'];
const methods = names.map(name => klass.members.find(n => n.name?.getText(renderer) === name));
assert(methods.every(Boolean));
const js = ts.transpileModule('class ActualMethods {' + methods.map(n => n.getText(renderer)).join('\n') + '}\nmodule.exports=ActualMethods;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const blockly = parse('src/app/editors/blockly-editor/components/blockly/blockly.component.ts');
const hook = find(blockly, n => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText(blockly) === 'console.error');
assert(hook);
const cmd = parse('electron/cmd.js', ts.ScriptKind.JS);
const channelScope = find(cmd, n => ts.isVariableDeclaration(n) && n.name.getText(cmd) === 'classifiedSimulatorStderr');
const factory = find(cmd, n => ts.isVariableDeclaration(n) && n.name.getText(cmd) === 'ownerCleanupDiagnostics');
const on = find(cmd, n => ts.isCallExpression(n) && n.expression.getText(cmd) === 'process.stderr.on' && n.arguments[0]?.text === 'data');
assert(channelScope && factory && on);

// Actual Main command callback -> actual Renderer methods -> actual Blockly
// console.error hook. Only native/log/notice ports are inert, no live commands.
function chain({ id = 'simulator', stream = 'child_tool_simulator_PURE', enabled = true } = {}) {
    const persisted = [], forwarded = [], project = [], notices = [], order = [];
    const consolePort = { log() {}, info() {}, warn(value) { persisted.push(JSON.parse(value)); }, error() {} };
    const hookFactory = new Function('console', 'HttpErrorResponse', 'let isHandlingError=false;return (' + hook.right.getText(blockly) + ');');
    consolePort.error = hookFactory.call({ noticeService: { update: value => notices.push(value) } }, consolePort, class HttpErrorResponse {});
    const module = { exports: {} };
    new Function('module', 'console', js)(module, consolePort);
    const service = new module.exports();
    service.appendChildToolLog = (...args) => project.push(args);
    const processFailures = [];
    service.rejectReady = (_session, reason) => processFailures.push(reason);
    service.handleClose = () => {};
    service.publishRuntimeState = () => {};
    const session = { streamId: stream, stderrBuffer: '' };
    const deliver = (_sender, _channel, event) => {
        forwarded.push(structuredClone(event));
        order.push(event.type);
        service.handleProcessOutput({ id }, session, stream, event);
    };
    const options = { env: { AILY_CHILD_TOOL_ID: enabled ? 'simulator' : 'other' }, messagePort: { transport: 'node-ipc-v1' } };
    const setup = new Function('options', 'streamId', 'createSimulatorOwnerCleanupDiagnostics', 'console', 'sendCmdData', 'senderWindow',
        'const ' + channelScope.getText(cmd) + ';const ' + factory.getText(cmd) + ';return {ownerCleanupDiagnostics,classifiedSimulatorStderr};');
    const state = setup(options, stream, createSimulatorOwnerCleanupDiagnostics, consolePort, deliver, {});
    const callback = new Function('ownerCleanupDiagnostics', 'classifiedSimulatorStderr', 'result', 'streamId', 'sendCmdData', 'senderWindow', 'logCommandOutput', 'data', on.arguments[1].body.getText(cmd).slice(1, -1));
    return {
        persisted, forwarded, project, notices, order, session, processFailures,
        push(data) {
            const before = session.stderrBuffer;
            callback(state.ownerCleanupDiagnostics, state.classifiedSimulatorStderr, { shouldLogOutput: false }, stream, deliver, {}, () => assert.fail('No unrelated output logger'), data);
            assert.equal(session.stderrBuffer, before + data.toString());
            assert.equal(forwarded.filter(x => x.type === 'stderr').at(-1).data, data.toString());
        },
        close() { state.ownerCleanupDiagnostics.close(); },
        inject(event, callerStream = stream) { service.handleProcessOutput({ id }, session, callerStream, event); },
    };
}

test('D15 actual Main -> Renderer -> Blockly valid diagnostic persists with exact immediate raw stderr and no error toast', () => {
    const c = chain(); const data = Buffer.from(frame()); c.push(data); c.close();
    assert.deepEqual(c.persisted, [valid()]); assert.equal(c.notices.length, 0);
    assert.deepEqual(c.order, ['stderr', 'stderr-notice']);
    assert.equal(c.session.stderrBuffer, data.toString()); assert.equal(c.project.length, 1); assert.equal(c.project[0][2], 'INFO');
});
test('D15 strict invalid prefix or extra fields remain ordinary error notifications, no prefix suppression', () => {
    for (const value of [{ ...valid(), status: 'not-an-enum' }, { ...valid(), message: 'ordinary fixture detail' }]) {
        const c = chain(); c.push(Buffer.from(frame(value))); c.close();
        assert.equal(c.persisted.length, 0); assert.equal(c.notices.length, 1); assert.equal(c.project[0][2], 'ERROR');
    }
});
test('D15 mixed actual chunk preserves ordinary errors and only classifies the validated line privately', () => {
    for (const data of ['ordinary fixture stderr\n' + frame(), frame() + 'ordinary fixture stderr\n']) {
        const c = chain(); c.push(Buffer.from(data)); c.close();
        assert.equal(c.session.stderrBuffer, data); assert.equal(c.persisted.length, 1); assert.equal(c.notices.length, 1);
        assert.equal(c.project.filter(x => x[2] === 'ERROR').length, 1);
    }
});
test('D15 byte-split diagnostic, CRLF, multiple frames and final tail reuse strict stream decoder', () => {
    const data = Buffer.from(frame(valid(), '\r\n') + frame(valid(), ''));
    for (const width of [1, 7, 31, 1023]) {
        const c = chain(); for (let at = 0; at < data.length; at += width) c.push(data.subarray(at, at + width));
        assert.equal(c.persisted.length, 1); c.close(); c.close(); assert.equal(c.persisted.length, 2); assert.equal(c.notices.length, 0);
        assert.equal(c.session.stderrBuffer, data.toString());
    }
});
test('D15 split ordinary UTF-8 retains prior raw per-chunk buffer contract and emits an ordinary complete-line error', () => {
    const data = Buffer.from('ordinary 错误🧪\r\n'); const c = chain(); let raw = '';
    for (const byte of data) { const part = Buffer.from([byte]); raw += part.toString(); c.push(part); }
    c.close(); assert.equal(c.session.stderrBuffer, raw); assert.ok(c.notices.length > 0);
    assert.equal(c.forwarded.filter(x => x.type === 'stderr-notice').map(x => x.data).join(''), 'ordinary 错误🧪');
});
test('D15 valid diagnostics with actual rejected status are telemetry; original process error still raises user error', () => {
    const c = chain(); c.push(Buffer.from(frame({ ...valid(), status: 'rejected' }))); c.close(); assert.equal(c.notices.length, 0);
    c.inject({ type: 'error', error: 'actual process fixture failure', streamId: c.session.streamId });
    assert.equal(c.notices.length, 1);
    assert.deepEqual(c.processFailures, ['actual process fixture failure']);
});
test('D15 known ordinary tail is an immediate error without newline and does not duplicate on physical close', () => {
    const c = chain(); c.push(Buffer.from('ordinary final tail')); assert.equal(c.notices.length, 1);
    assert.equal(c.session.stderrBuffer, 'ordinary final tail'); c.close(); c.close(); assert.equal(c.notices.length, 1);
});
test('D15 overlong/malformed UTF-8 lines have bounded ordinary notices and never safe persistence', () => {
    for (const bytes of [Buffer.from(frame(valid(), '') + ' '.repeat(12000)), Buffer.alloc(15000, 0xff)]) {
        const c = chain(); c.push(bytes); assert.ok(c.notices.length > 0); c.close();
        assert.equal(c.persisted.length, 0); assert.ok(c.project.every(x => x[2] === 'ERROR'));
        const notices = c.forwarded.filter(x => x.type === 'stderr-notice');
        assert.ok(notices.every(x => Buffer.byteLength(x.data, 'utf8') <= 4096));
        assert.equal(c.session.stderrBuffer, bytes.toString());
    }
});
test('D15 exact 4096-byte ordinary line and following private frame do not share dropped-line state', () => {
    const c = chain(); c.push(Buffer.from('x'.repeat(4096) + '\n' + frame())); c.close();
    assert.equal(c.notices.length, 1); assert.equal(c.persisted.length, 1);
});
test('D15 disabled/wrong command scope never attests raw stderr as private', () => {
    for (const options of [{ enabled: false }, { stream: 'unrelated_process' }]) {
        const c = chain(options); c.push(Buffer.from(frame())); c.close();
        assert.equal(c.persisted.length, 0); assert.equal(c.notices.length, 1);
        assert.equal(c.forwarded.length, 1); assert.equal(c.forwarded[0].stderrPresentation, undefined);
    }
    const c = chain({ id: 'other' }); c.push(Buffer.from(frame())); c.close(); assert.ok(c.notices.length > 0);
});
test('D15 stale stream, missing/foreign marker, bad notice shape cannot downgrade ordinary errors', () => {
    const c = chain(); c.inject({ type: 'stderr', data: 'ordinary', streamId: c.session.streamId }); assert.equal(c.notices.length, 1);
    c.inject({ type: 'stderr-notice', data: 'not trusted', streamId: 'foreign', stderrPresentation: 'main-simulator-line-v1', classification: 'internal-cleanup' });
    c.inject({ type: 'stderr-notice', data: 'not trusted', streamId: c.session.streamId, stderrPresentation: 'other', classification: 'internal-cleanup' });
    c.inject({ type: 'stderr-notice', data: 'not trusted', streamId: c.session.streamId, stderrPresentation: 'main-simulator-line-v1', classification: 'unknown' });
    c.inject({ type: 'stderr-notice', data: 'x'.repeat(4097), streamId: c.session.streamId, stderrPresentation: 'main-simulator-line-v1', classification: 'internal-cleanup' });
    assert.equal(c.notices.length, 5);
    c.inject({ type: 'stderr', data: 'stale', streamId: 'old' }, 'old'); assert.equal(c.session.stderrBuffer, 'ordinary'); assert.equal(c.notices.length, 5);
});
test('D15 legacy three-field persistence remains exact and does not gain a blanket private stderr exemption', () => {
    const value = { event: 'simulator-owner-cleanup-stage-failed', stage: 'owner.application', errorCode: 'cleanup-failed' };
    const c = chain(); c.push(Buffer.from(JSON.stringify(value) + '\n')); c.close();
    assert.deepEqual(c.persisted, [value]); assert.equal(c.notices.length, 1);
});
test('D15 synchronous and asynchronous persistence/notice sink failure is isolated without unhandled rejection or retained queue', async () => {
    for (const observer of [() => { throw new Error('inert sink'); }, async () => { throw new Error('inert sink'); }]) {
        const owner = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: observer, notice: observer });
        assert.equal(owner.push(Buffer.from(frame() + 'ordinary\n')), undefined); assert.equal(owner.close(), undefined);
    }
    await new Promise(resolve => setImmediate(resolve));
});

// Load the unchanged real CmdService with real RxJS using its existing in-memory
// source fixture. Notices must never count as raw stderr or a physical terminal.
test('D15 actual CmdService forwards private notices without duplicating raw stderr or completing early', async () => {
    const vm = require('node:vm');
    const source = parse('electron/cmd-renderer-consumer.test.js', ts.ScriptKind.JS);
    const fixture = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'fixture');
    assert(fixture);
    const f = new Function('ts', 'fs', 'path', 'vm', 'require', 'assert', '__dirname', 'console', 'return (' + fixture.getText(source) + ')();')
        (ts, fs, path, vm, require, assert, __dirname, { log() {}, info() {}, warn() {}, error() {} });
    const values = []; let complete = false;
    f.service.spawn('memory-only', [], { streamId: 'child_tool_simulator_PURE' }).subscribe({ next: value => values.push(value), complete: () => { complete = true; } });
    await Promise.resolve();
    const raw = frame();
    f.emit('child_tool_simulator_PURE', { type: 'stderr', data: raw, stderrPresentation: 'main-simulator-line-v1' });
    f.emit('child_tool_simulator_PURE', { type: 'stderr-notice', data: JSON.stringify(valid()), stderrPresentation: 'main-simulator-line-v1', classification: 'internal-cleanup' });
    assert.equal(complete, false); assert.equal(values.length, 2);
    f.emit('child_tool_simulator_PURE', { type: 'close', code: 0 });
    assert.equal(complete, true); assert.equal(values.at(-1).stderr, raw);
});

test('D15 a02 partial exact prefix alone may wait, prefix mismatch immediately exposes the original ordinary tail', () => {
    const c = chain(); c.push(Buffer.from('AILY_')); assert.equal(c.notices.length, 0);
    c.push(Buffer.from('ordinary no newline')); assert.equal(c.notices.length, 1);
    assert.equal(c.forwarded.filter(x => x.type === 'stderr-notice').map(x => x.data).join(''), 'AILY_ordinary no newline');
    c.close(); assert.equal(c.notices.length, 1); assert.equal(c.persisted.length, 0);
});
test('D15 a02 truncated potential private prefix becomes ordinary only at final tail and cannot remain hidden', () => {
    const c = chain(); c.push(Buffer.from('AILY_INTERNAL_')); assert.equal(c.notices.length, 0);
    c.close(); c.close(); assert.equal(c.notices.length, 1); assert.equal(c.persisted.length, 0);
});
