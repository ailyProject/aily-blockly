const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveBuilderInvocation } = require('./builder-invocation');

test('uses the managed builder outside an explicit E2E override', () => {
    assert.deepEqual(
        resolveBuilderInvocation(['compile', '"C:\\project path\\sketch.ino"'], {
            env: {},
            execPath: 'node'
        }),
        {
            command: 'aily-builder',
            args: ['compile', '"C:\\project path\\sketch.ino"'],
            shell: true
        }
    );
});

test('runs the exact local builder entry during E2E', () => {
    const entry = __filename;
    assert.deepEqual(
        resolveBuilderInvocation(['compile', `"${entry}"`], {
            env: {
                AILY_E2E: '1',
                AILY_E2E_BUILDER_ENTRY: entry
            },
            execPath: 'node'
        }),
        {
            command: 'node',
            args: [entry, 'compile', entry],
            shell: false
        }
    );
});

test('rejects the E2E override outside E2E mode', () => {
    assert.throws(
        () => resolveBuilderInvocation([], {
            env: { AILY_E2E_BUILDER_ENTRY: __filename }
        }),
        /仅允许在 AILY_E2E=1/
    );
});
