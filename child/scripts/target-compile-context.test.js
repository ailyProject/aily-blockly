const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { captureInputs, splitArguments, createTargetCompileContext, publishTargetCompileContext } = require('./target-compile-context');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-build-context-'));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('aily-build-context-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const compiler = path.join(root, 'target-g++.exe');
    fs.writeFileSync(compiler, 'compiler fixture');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const flags = path.join(root, 'flags with spaces');
    fs.writeFileSync(flags, '-std=gnu++17 -DSDK_CONFIG=1');
    const data = { success: true, envVars: { COMPILER_GPP_PATH: compiler },
        compileConfig: { args: { cpp: `-MMD -c "@${flags}" "-DBOARD=\\"Board A\\"" %INCLUDE_PATHS% "%SOURCE_FILE_PATH%" -o "%OBJECT_FILE_PATH%"` } },
        dependencies: [{ path: root }] };
    const file = path.join(root, 'preprocess.json');
    const save = () => fs.writeFileSync(file, JSON.stringify(data));
    save();
    return { root, file, data, save, flags, inputs: captureInputs([path.join(root, 'package.json')]) };
}

test('recipe tokenization preserves quoted defines and Windows paths without running a shell', () => {
    assert.deepEqual(splitArguments(String.raw`"-IC:\SDK path\inc" "-DNAME=\"value\"" -iprefix "D:\prefix/"`),
        ['-IC:\\SDK path\\inc', '-DNAME="value"', '-iprefix', 'D:\\prefix/']);
    assert.throws(() => splitArguments('"unfinished'), /Unterminated/);
});
test('resolved test context retains target flags, response files and provenance, but no object/dependency writes', t => {
    const f = fixture(t);
    const result = createTargetCompileContext(f.file, f.root, f.inputs);
    assert.deepEqual(result.flags, ['@' + f.flags, '-DBOARD="Board A"', '-I' + f.root]);
    assert.equal(result.inputs.length, 4);
    assert.equal(result.project, f.root);
});
test('configuration changes cannot be published as a ready test context', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"board":"different"}');
    const result = publishTargetCompileContext(f.file, f.root, f.inputs);
    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, /changed during preprocessing/);
});
test('unsupported recipes and nested output flags invalidate rather than guess', t => {
    const f = fixture(t);
    f.data.compileConfig.args.cpp += ' {missing.flag}'; f.save();
    assert.throws(() => createTargetCompileContext(f.file, f.root, f.inputs), /Unresolved|Unsupported/);
    f.data.compileConfig.args.cpp = `"@${f.flags}"`; f.save();
    fs.writeFileSync(f.flags, '-MMD');
    assert.throws(() => createTargetCompileContext(f.file, f.root, f.inputs), /output\/dependency/);
});
test('actual installed board recipe compiles an SDK-dependent assertion without manually selected includes', {
    skip: !process.env.AILY_TEST_PREPROCESS && 'Set AILY_TEST_PREPROCESS to existing current build evidence',
}, t => {
    const f = fixture(t);
    const preprocess = path.resolve(process.env.AILY_TEST_PREPROCESS);
    const project = path.dirname(path.dirname(preprocess));
    const context = createTargetCompileContext(preprocess, project, captureInputs([path.join(project, 'package.json')]));
    const source = path.join(f.root, 'sdk-check.cpp');
    fs.writeFileSync(source, '#include <sdkconfig.h>\n#include <driver/mcpwm_prelude.h>\nstatic_assert(sizeof(int)==4);\n');
    const result = spawnSync(context.compiler, [...context.flags, '-fsyntax-only', source], {
        cwd: project, encoding: 'utf8', timeout: 25000, windowsHide: true, shell: false,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    fs.appendFileSync(source, 'static_assert(sizeof(int)==99,"deliberate negative control");');
    const failed = spawnSync(context.compiler, [...context.flags, '-fsyntax-only', source], {
        cwd: project, encoding: 'utf8', timeout: 25000, windowsHide: true, shell: false,
    });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /static assertion failed/);
});
