'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

// Exercise the actual small Renderer sources in memory, with real RxJS. No
// Angular application build, browser, dependency installation or asset output.
function fixture() {
  const directory = path.join(__dirname, '../src/app/services/core/platform'), cache = new Map();
  const listeners = new Map(), calls = [], logs = [], window = { cmd: {
    onData: (id, listener) => { listeners.set(id, listener); return () => listeners.delete(id); },
    run: async options => { calls.push(options); return { success: true }; }, kill: async () => ({ success: false }),
  } };
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const filename = path.join(directory, name + '.ts');
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, isolatedModules: true },
    });
    assert.deepEqual(compiled.diagnostics.filter(value => value.category === ts.DiagnosticCategory.Error), []);
    const module = { exports: {} }; cache.set(name, module.exports);
    vm.runInNewContext(compiled.outputText, { module, exports: module.exports, window, console,
      AbortController, TextEncoder, setTimeout, clearTimeout,
      require: id => {
        if (id === '@angular/core') return { Injectable: () => value => value };
        if (id === './log.service') return { LogService: class {} };
        if (id === './cmd-output') return load('cmd-output');
        return require(id);
      } }, { filename });
    return module.exports;
  }
  const { CmdService } = load('cmd.service');
  return { service: new CmdService({ update: value => logs.push(value) }), listeners, calls, logs, window,
    types: load('cmd-output'), emit: (id, event) => listeners.get(id)?.({ streamId: id, ...event }) };
}
const terminal = (code = 0, signal = null) => ({ type: 'terminal', code, signal,
  terminal: { kind: 'exit-and-stdio-closed', code, signal, closeObserved: false } });

test('the shared Renderer predicate distinguishes legacy close from an independently verified physical terminal', () => {
  const { types } = fixture();
  assert.equal(types.isCmdTerminalOutput({ type: 'close' }), true);
  assert.equal(types.isCmdTerminalOutput(terminal()), true);
  for (const value of [{ type: 'terminal' }, { ...terminal(), code: 9 },
    { ...terminal(), terminal: { ...terminal().terminal, closeObserved: true } },
    { type: 'runtime-exit' }, { type: 'stdout' }]) assert.equal(types.isCmdTerminalOutput(value), false);
});

test('the actual command interface and service pass semantic isolatedModules checking without emitting assets', () => {
  const root = path.resolve(__dirname, '..'), directory = path.join(root, 'src/app/services/core/platform');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
  assert.deepEqual(converted.errors, []);
  const options = { ...converted.options, noEmit: true, types: [], importHelpers: false };
  const angular = path.join(directory, '__cmd-test-angular.d.ts'), log = path.join(directory, '__cmd-test-log.d.ts');
  const virtual = new Map([[angular, 'export declare function Injectable(value: any): ClassDecorator;'],
    [log, 'export declare class LogService { update(value: any): void; }']]);
  const host = ts.createCompilerHost(options), originalGet = host.getSourceFile.bind(host), writes = [];
  host.writeFile = filename => writes.push(filename);
  host.getSourceFile = (file, language, onError, createNew) => virtual.has(file)
    ? ts.createSourceFile(file, virtual.get(file), language, true) : originalGet(file, language, onError, createNew);
  host.resolveModuleNames = (names, containing) => names.map(name => {
    if (name === '@angular/core') return { resolvedFileName: angular, extension: ts.Extension.Dts };
    if (name === './log.service') return { resolvedFileName: log, extension: ts.Extension.Dts };
    return ts.resolveModuleName(name, containing, options, host).resolvedModule
      || ts.resolveModuleName(name, 'D:/codes/aily-blockly/cmd-test-entry.ts', options, host).resolvedModule;
  });
  const program = ts.createProgram([path.join(directory, 'cmd-output.ts'), path.join(directory, 'cmd.service.ts')], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(value => value.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(diagnostics.map(value => ({ code: value.code, message: ts.flattenDiagnosticMessageText(value.messageText, '\n') })), []);
  assert.equal(options.isolatedModules, true); assert.equal(options.noEmit, true);
  program.emit(); assert.deepEqual(writes, []);
});

for (const queued of [false, true]) test(`actual CmdService ${queued ? 'queued' : 'direct'} fallback completes and keeps its distinct type`, async () => {
  const f = fixture(); const pending = f.service.runAsyncChecked('node job', '/project', queued, true, { streamId: 'command' });
  f.emit('command', { type: 'stdout', data: 'output' }); f.emit('command', terminal());
  const result = await pending;
  assert.equal(result.type, 'terminal'); assert.equal(result.terminal.closeObserved, false);
  assert.equal(result.stdout, 'output'); assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].command, 'node');
});

test('fallback reports a real nonzero or signalled result instead of silently returning success', async () => {
  for (const [code, signal] of [[7, null], [null, 'SIGTERM']]) {
    const f = fixture(); const pending = f.service.runAsyncChecked('node job', '/project', false, true, { streamId: 'failed' });
    const rejected = assert.rejects(pending);
    f.emit('failed', { type: 'stderr', data: 'actual diagnostic' }); f.emit('failed', terminal(code, signal));
    await rejected; assert.equal(f.listeners.size, 0);
  }
});

test('unconfirmed or mismatched terminal metadata does not settle a queued task', async () => {
  const f = fixture(); let settled = false;
  const pending = f.service.runAsync('node job', '/project', true, true, { streamId: 'held' }).then(value => { settled = true; return value; });
  f.emit('held', { type: 'terminal', code: 0 }); await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.listeners.size, 1);
  f.emit('held', terminal()); const result = await pending; assert.equal(result.type, 'terminal');
});

test('late close after a fallback is ignored and output accumulation stays bounded', async () => {
  const f = fixture(), values = []; let completed = 0;
  f.service.spawn('node', [], { streamId: 'bounded' }, true).subscribe({ next: value => values.push(value), complete: () => completed++ });
  const late = f.listeners.get('bounded');
  f.emit('bounded', { type: 'stderr', data: 'x'.repeat(4000) }); f.emit('bounded', terminal(8));
  late({ type: 'close', streamId: 'bounded', code: 0 });
  assert.equal(completed, 1); assert.equal(values.length, 2);
  assert.equal(values[1].stderr.length, 2000); assert.equal(values[1].type, 'terminal');
  assert.equal(f.listeners.size, 0);
});

test('physical terminal completion leaves explicit Main cleanup unconfirmed when kill rejects it', async () => {
  const f = fixture(); const pending = f.service.runAsync('node job', '/project', false, true, { streamId: 'owned' });
  f.emit('owned', terminal()); await pending;
  assert.equal(await f.service.kill('owned'), false);
});

test('the next queued command begins after a fallback, while legacy close stays unchanged', async () => {
  const f = fixture();
  const first = f.service.runAsync('node one', '/project', true, true, { streamId: 'one' });
  const second = f.service.runAsync('node two', '/project', true, true, { streamId: 'two' });
  assert.equal(f.calls.length, 1); f.emit('one', terminal()); await first; await Promise.resolve();
  assert.equal(f.calls.length, 2); f.emit('two', { type: 'close', code: 0 });
  assert.equal((await second).type, 'close'); assert.equal(f.listeners.size, 0);
});

test('all existing command consumers use the shared terminal distinction and registry exit never fabricates close', () => {
  const files = [
    'src/app/integrations/build/project-compiler-configuration.service.ts', 'src/app/services/domains/build/compile.service.ts',
    'src/app/windows/settings/settings.component.ts', 'src/app/editors/code-editor-pro/code-editor-frame.component.ts',
    'src/app/main-window/components/header/header.component.ts', 'src/app/tools/cloud-space/services/cloud.service.ts',
    'src/app/editors/blockly-editor/services/uploader.service.ts', 'src/app/editors/blockly-editor/services/builder.service.ts',
    'src/app/services/integrations/subapps/child-tool-process.service.ts',
  ];
  for (const file of files) {
    const filename = path.join(__dirname, '..', file), source = fs.readFileSync(filename, 'utf8');
    assert.match(source, /isCmdTerminalOutput/u, file);
    assert.doesNotMatch(source, /\b(?:output|event|o)\.type === 'close'/u, file);
    const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, isolatedModules: true } });
    assert.deepEqual(result.diagnostics.filter(value => value.category === ts.DiagnosticCategory.Error), [], file);
  }
  const child = fs.readFileSync(path.join(__dirname, '../src/app/services/integrations/subapps/child-tool-process.service.ts'), 'utf8');
  assert.match(child, /\{ \.\.\.exited\.exit, type: 'runtime-exit' \}/u);
  assert.doesNotMatch(child, /\{ type: 'close', \.\.\.exited\.exit \}/u);
});
