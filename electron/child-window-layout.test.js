const assert = require('node:assert/strict');
const test = require('node:test');

const {
    resolveChildWindowClass,
    resolveChildWindowMinimumSize,
} = require('./child-window-layout');

test('classifies built-in windows by default', () => {
    assert.equal(resolveChildWindowClass('/settings'), 'builtin');
    assert.equal(resolveChildWindowClass('/code-viewer'), 'builtin');
});

test('keeps subapp windows independent through explicit class or legacy route fallback', () => {
    assert.equal(resolveChildWindowClass('/apps/custom-surface', 'subapp'), 'subapp');
    assert.equal(resolveChildWindowClass('/child-tool/aily-chat'), 'subapp');
    assert.equal(resolveChildWindowClass('/child-tool/aily-chat', 'builtin'), 'builtin');
});

test('uses a larger minimum for built-in detached windows', () => {
    assert.deepEqual(resolveChildWindowMinimumSize('/settings'), {
        width: 640,
        height: 480,
    });
});

test('keeps external subapp windows at least 400 by 500 without relying on their route', () => {
    assert.deepEqual(resolveChildWindowMinimumSize('/apps/serial-debugger', {}, 'subapp'), {
        width: 400,
        height: 500,
    });
});

test('keeps child-tool route detection only as a compatibility fallback', () => {
    assert.deepEqual(resolveChildWindowMinimumSize('http://localhost:4200/#/child-tool/aily-chat'), {
        width: 400,
        height: 500,
    });
});

test('honors an external subapp surface minimum when it is larger than the host floor', () => {
    assert.deepEqual(resolveChildWindowMinimumSize('/child-tool/model-store?surface=deploy', {
        width: 720,
        height: 560,
    }, 'subapp'), {
        width: 720,
        height: 560,
    });
});

test('does not allow callers to weaken either window minimum', () => {
    assert.deepEqual(resolveChildWindowMinimumSize('/settings', {
        width: 400,
        height: 300,
    }), {
        width: 640,
        height: 480,
    });
    assert.deepEqual(resolveChildWindowMinimumSize('/external/aily-chat', {
        width: 160,
        height: 120,
    }, 'subapp'), {
        width: 400,
        height: 500,
    });
});
