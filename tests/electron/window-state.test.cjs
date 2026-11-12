const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowStateController, fitNormalBounds } = require('../../electron/window-state');

function fixture(area = { x: 0, y: 0, width: 1707, height: 912 }) {
    const screen = new EventEmitter();
    let display = { id: 1, workArea: area, bounds: area, scaleFactor: 2.25 };
    screen.getPrimaryDisplay = () => display;
    screen.getDisplayMatching = () => display;
    screen.getAllDisplays = () => [display];
    const win = new EventEmitter();
    Object.assign(win, { bounds: { x: 90, y: 60, width: 1100, height: 750 }, maximized: false,
        fullscreen: false, minimized: false, dead: false, minimum: [800, 600], sent: [], calls: [] });
    win.isDestroyed = () => win.dead;
    win.isMaximized = () => win.maximized;
    win.isFullScreen = () => win.fullscreen;
    win.isMinimized = () => win.minimized;
    win.isResizable = win.isMaximizable = () => true;
    win.getBounds = () => ({ ...win.bounds });
    win.getNormalBounds = () => ({ x: 90, y: 60, width: 1100, height: 750 });
    win.getMinimumSize = () => win.minimum;
    win.setMinimumSize = (w, h) => { win.minimum = [w, h]; };
    win.setBounds = bounds => { win.bounds = { ...bounds }; win.emit('resize'); };
    win.webContents = { isDestroyed: () => false, send: (_channel, value) => win.sent.push(value) };
    win.setFullScreen = value => { win.calls.push('fullscreen'); win.fullscreen = value; win.emit('leave-full-screen'); };
    win.unmaximize = () => { win.calls.push('unmaximize'); win.maximized = false; win.emit('unmaximize'); };
    win.maximize = () => { win.calls.push('maximize'); win.maximized = true; win.bounds = { ...display.workArea }; win.emit('maximize'); };
    win.restore = () => { win.minimized = win.maximized = false; };
    const controller = createWindowStateController({ screen, platform: 'win32', transitionTimeout: 10 });
    return { win, screen, controller, setDisplay: next => { display = { ...display, ...next }; } };
}

for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    for (const scale of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
        test(`${width}x${height} at ${scale * 100}% restores inside the DIP work area`, () => {
            const area = { x: -Math.round(width / scale), y: 27, width: Math.floor(width / scale), height: Math.floor(height / scale) - 48 };
            for (const saved of [null, { x: NaN, y: 0, width: 100, height: 100 },
                { x: 9000, y: -4000, width: 4200, height: 3000 }, { ...area },
                { x: area.x + area.width - 1, y: 28, width: 1200, height: 780 }]) {
                const normal = fitNormalBounds(saved, area);
                assert.ok(Object.values(normal).every(Number.isInteger));
                assert.ok(normal.x >= area.x && normal.y >= area.y);
                assert.ok(normal.x + normal.width < area.x + area.width);
                assert.ok(normal.y + normal.height < area.y + area.height);
            }
        });
    }
}

test('fullscreen with false native maximized state restores, publishes state, and coalesces repeated clicks', async () => {
    const f = fixture();
    f.controller.attach(f.win);
    f.win.fullscreen = true;
    f.win.bounds = { x: 0, y: 0, width: 1707, height: 960 };
    assert.equal(f.controller.snapshot(f.win).canRestore, true);
    const first = f.controller.change(f.win), second = f.controller.change(f.win);
    assert.equal(first, second);
    const result = await first;
    assert.equal(result.success, true);
    assert.equal(result.state.canRestore, false);
    assert.deepEqual(f.win.calls, ['fullscreen']);
    assert.equal(f.win.sent.at(-1).canRestore, false);
});

test('restores an oversized ordinary window even when native unmaximize would be a no-op', async () => {
    const f = fixture(); f.win.bounds = { x: -8, y: -8, width: 2000, height: 1200 };
    assert.equal((await f.controller.change(f.win)).state.canRestore, false);
    assert.equal(f.win.calls.includes('unmaximize'), false);
});

test('maximizing then restoring retains normal bounds, including after stale native restore geometry', async () => {
    const f = fixture(); const original = { ...f.win.bounds };
    assert.equal((await f.controller.change(f.win)).state.maximized, true);
    assert.equal((await f.controller.change(f.win)).state.canRestore, false);
    assert.deepEqual(f.win.bounds, original);
});

test('DPI changes and removed monitors repair normal bounds and minimum size; screen listeners are released', () => {
    const f = fixture(); f.controller.attach(f.win);
    f.setDisplay({ workArea: { x: 0, y: 0, width: 683, height: 360 } });
    f.screen.emit('display-removed');
    assert.ok(f.win.bounds.width < 683 && f.win.bounds.height < 360);
    assert.ok(f.win.minimum[0] <= f.win.bounds.width && f.win.minimum[1] <= f.win.bounds.height);
    f.setDisplay({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } });
    f.screen.emit('display-metrics-changed');
    assert.deepEqual(f.win.minimum, [800, 600]);
    f.win.dead = true; f.win.emit('closed');
    assert.equal(f.screen.listenerCount('display-metrics-changed'), 0);
});

test('failed fullscreen exits report failure without pretending the window was restored', async () => {
    const f = fixture(); f.win.fullscreen = true;
    f.win.setFullScreen = () => {};
    const result = await f.controller.change(f.win);
    assert.equal(result.success, false);
    assert.equal(result.state.fullScreen, true);
    assert.equal(f.win.listenerCount('leave-full-screen'), 1); // permanent state publisher only
});


test('minimizing a maximized window retains its restore mode for persistence', async () => {
    const f = fixture(); await f.controller.change(f.win);
    f.win.minimized = true; f.win.maximized = false;
    assert.equal(f.controller.snapshot(f.win).mode, 'maximized');
});


test('a work-area shrink repairs a covering ordinary window without changing native fullscreen/maximized windows', () => {
    const f = fixture(); f.controller.attach(f.win);
    f.setDisplay({ workArea: { x: 0, y: 0, width: 800, height: 500 } });
    f.win.bounds = { x: 0, y: 0, width: 1707, height: 960 };
    f.screen.emit('display-metrics-changed');
    assert.equal(f.controller.snapshot(f.win).canRestore, false);
    f.win.maximized = true; const bounds = { ...f.win.bounds };
    f.screen.emit('display-metrics-changed'); assert.deepEqual(f.win.bounds, bounds);
});


test('maximizing on the same display never reapplies native minimum constraints', async () => {
    const f = fixture();
    f.controller.attach(f.win);
    f.win.setMinimumSize = () => { throw new Error('Native constraint update would cancel maximize'); };
    const result = await f.controller.change(f.win);
    assert.equal(result.success, true);
    assert.equal(result.state.maximized, true);
});
