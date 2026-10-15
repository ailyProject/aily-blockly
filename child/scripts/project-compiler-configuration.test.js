const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { decodeRequest, projectCppCommandLineDefinitions: project,
    readCompilerConfiguration, resolveBuilderPackage, unavailableConfiguration } = require('./project-compiler-configuration');

const fqbn = 'vendor:architecture:board';
const definition = (name, value, state = 'defined') => ({ name, value, state });

test('observes direct definitions and undefinitions without executing or exposing a recipe', () => {
    const result = project(String.raw`-DNUMBER=0 -D FLAG -DCORE=ArduinoCore -DHEX=0x10UL -USYMBOL -U OTHER -IC:\SDK -o C:\output.o`, fqbn, '1.2.3');
    assert.equal(result.status, 'available');
    assert.deepEqual(result.definitions, [definition('CORE', 'ArduinoCore'), definition('FLAG', '1'),
        definition('HEX', '0x10UL'), definition('NUMBER', '0'), definition('OTHER', null, 'undefined'),
        definition('SYMBOL', null, 'undefined')]);
    assert.deepEqual(result.limitations, ['cpp-preprocessing-not-performed']);
    assert.doesNotMatch(JSON.stringify(result), /SDK|output|recipe/);
});

test('quoted paths, expressions, secrets and unsupported values become bounded ambiguity', () => {
    const result = project(String.raw`"-DSDK_PATH=\"C:\SDK private\"" -DTOKEN="bearer-secret" -DX=1+2 -DEMPTY= -DREAL=-1.25e+2f`, fqbn, null);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.definitions, [definition('EMPTY', null, 'ambiguous'), definition('REAL', '-1.25e+2f'),
        definition('SDK_PATH', null, 'ambiguous'), definition('TOKEN', null, 'ambiguous'), definition('X', null, 'ambiguous')]);
    assert.ok(result.limitations.includes('unsupported-definition-value'));
    assert.doesNotMatch(JSON.stringify(result), /private|bearer-secret|1\+2/);
});

test('conflicting declarations never silently choose a new effective macro', () => {
    const result = project('-DA=0 -DA=0 -DB=1 -UB -DB=1 -DC=0 -DC=1', fqbn, null);
    assert.deepEqual(result.definitions, [definition('A', '0'), definition('B', null, 'ambiguous'), definition('C', null, 'ambiguous')]);
    assert.ok(result.limitations.includes('conflicting-definitions'));
});

test('response files remain unevaluated; direct observed declarations stay visible', () => {
    const result = project('-DARDUINO_USB_CDC_ON_BOOT=0 "@C:\\not-read\\secret.rsp"', fqbn, '3.3.1');
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.definitions, [definition('ARDUINO_USB_CDC_ON_BOOT', '0')]);
    assert.ok(result.limitations.includes('response-files-not-evaluated'));
    assert.doesNotMatch(JSON.stringify(result), /not-read|secret/);
});

test('bounded names and definition count fail closed without trimming to fake completeness', () => {
    assert.deepEqual(project(Array.from({ length: 129 }, (_, index) => `-DNAME${index}=1`).join(' '), fqbn, null), unavailableConfiguration());
    const result = project(`-D${'A'.repeat(129)}=1 -DLARGE=${'1'.repeat(257)}`, fqbn, null);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.definitions, [definition('LARGE', null, 'ambiguous')]);
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-compiler-config-test-'));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('aily-compiler-config-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const projectPath = path.join(root, 'project');
    const boardModule = '@aily-project/board-test';
    const boardRoot = path.join(projectPath, 'node_modules', boardModule);
    const appDataPath = path.join(root, 'app-data');
    const sdk = path.join(appDataPath, 'sdk', 'test_1.0.0');
    const builder = path.join(root, 'builder');
    fs.mkdirSync(boardRoot, { recursive: true }); fs.mkdirSync(sdk, { recursive: true });
    fs.mkdirSync(path.join(builder, 'dist', 'src'), { recursive: true });
    const packageFile = path.join(projectPath, 'package.json');
    const boardFile = path.join(boardRoot, 'board.json');
    fs.writeFileSync(packageFile, JSON.stringify({ dependencies: { [boardModule]: '1' }, projectConfig: { Mode: 'exact' }, macros: ['CUSTOM=1'] }));
    fs.writeFileSync(boardFile, JSON.stringify({ compilerParam: `-b ${fqbn}` }));
    fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify({ name: boardModule,
        boardDependencies: { '@aily-project/sdk-test': '1.0.0', '@aily-project/tool-idf_test': '5.5.1' } }));
    fs.writeFileSync(path.join(sdk, 'boards.txt'), 'board.name=Current');
    fs.writeFileSync(path.join(sdk, 'platform.txt'), 'version=1.0.0');
    fs.writeFileSync(path.join(builder, 'package.json'), JSON.stringify({ name: '@aily-project/aily-builder', bin: { 'aily-builder': 'dist/main.js' } }));
    const entryPath = path.join(builder, 'dist', 'main.js');
    fs.writeFileSync(entryPath, '');
    fs.writeFileSync(path.join(builder, 'dist', 'src', 'ArduinoConfigParser.js'), '');
    fs.writeFileSync(path.join(builder, 'dist', 'src', 'CompileConfigManager.js'), '');
    const calls = [];
    const modules = {
        ArduinoConfigParser: class {
            async parseByFQBN(...args) {
                calls.push(args);
                process.env.SDK_PATH = 'temporary parser environment';
                return { targetSelection: { effectiveFqbn: `${fqbn}:Mode=exact`, platform: { version: '1.0.0' } } };
            }
        },
        CompileConfigManager: class { parseCompileConfig() { return { args: { cpp: '-DSELECTED=0' } }; } },
    };
    const request = { schemaVersion: 1, projectPath, boardModule, entryPath, appDataPath };
    return { root, request, modules, calls, packageFile, boardFile, sdk, builder };
}

test('managed package entry locates distributed parser modules, not a cache root', t => {
    const f = fixture(t), resolved = resolveBuilderPackage(f.request.entryPath);
    assert.equal(resolved.root, f.builder);
    assert.equal(resolved.parser, path.join(f.builder, 'dist', 'src', 'ArduinoConfigParser.js'));
    assert.throws(() => resolveBuilderPackage(path.join(f.builder, 'main.js')), /builder-entry/);
});

test('the managed builder status exposes an entry only for a ready installation', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'tools', 'builder.js'), 'utf8');
    const statusFields = source.match(/statusFields:\s*([^\n]+),\s*\r?\n/);
    assert.ok(statusFields, 'The configuration reader requires the managed status entry projection');
    const projection = require('node:vm').runInNewContext(`(${statusFields[1]})`);
    assert.equal(projection({ ok: true, entryPath: '/managed/dist/main.js' }).entryPath, '/managed/dist/main.js');
    assert.equal(projection({ ok: false, entryPath: '/stale/dist/main.js' }).entryPath, '');
    assert.equal(projection({ ok: true }).entryPath, '');
});

test('current SDK selection uses the original parser and manager without writing a workspace', async t => {
    const f = fixture(t), oldSdk = process.env.SDK_PATH;
    const result = await readCompilerConfiguration(f.request, { loadBuilderModules: () => f.modules });
    assert.equal(result.status, 'available');
    assert.equal(result.effectiveFqbn, `${fqbn}:Mode=exact`);
    assert.deepEqual(f.calls, [[fqbn, { Mode: 'exact' }, { 'esp32-arduino-libs': '5.5.1' }, ['CUSTOM=1']]]);
    assert.equal(process.env.SDK_PATH, oldSdk);
    assert.equal(fs.existsSync(path.join(f.request.projectPath, '.build')), false);
    assert.equal(fs.existsSync(path.join(f.request.projectPath, '.temp')), false);
});

for (const changed of ['packageFile', 'boardFile', 'sdk']) test(`changed ${changed} configuration rejects the captured facts`, async t => {
    const f = fixture(t);
    f.modules.ArduinoConfigParser = class {
        async parseByFQBN() {
            fs.appendFileSync(changed === 'sdk' ? path.join(f.sdk, 'platform.txt') : f[changed], '\n');
            return { targetSelection: { effectiveFqbn: fqbn, platform: { version: '1.0.0' } } };
        }
    };
    const failures = [];
    const result = await readCompilerConfiguration(f.request, { loadBuilderModules: () => f.modules, onFailure: stage => failures.push(stage) });
    assert.deepEqual(result, unavailableConfiguration());
    assert.deepEqual(failures, ['bookend']);
});

test('malformed or oversized transport requests reject before reading project data', () => {
    assert.throws(() => decodeRequest(Buffer.from('{"secret":"no"}').toString('base64')), /invalid-request/);
    assert.throws(() => decodeRequest('A'.repeat(30_000)), /invalid-request/);
    assert.throws(() => decodeRequest('@@@'), /invalid-request/);
});

test('CLI failure outputs only an explicit unavailable DTO and a safe stage', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.builder, 'dist', 'src', 'ArduinoConfigParser.js'),
        'exports.ArduinoConfigParser=class{async parseByFQBN(){console.warn("secret C:/private");throw Error("Bearer hidden credential C:/private");}};');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'project-compiler-configuration.js'),
        Buffer.from(JSON.stringify(f.request)).toString('base64')], { encoding: 'utf8', shell: false, timeout: 5_000, windowsHide: true });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), unavailableConfiguration());
    assert.match(result.stderr, /stage=parser/);
    assert.doesNotMatch(result.stdout + result.stderr, /private|Bearer|credential|secret/);
});
