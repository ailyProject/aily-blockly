const test = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateChildWindowLayout,
    chooseAutoLayout,
    clampBoundsToWorkArea,
} = require('./child-window-layout');

test('auto layout adapts to window count and display orientation', () => {
    assert.equal(chooseAutoLayout(1, { width: 1920, height: 1080 }), 'grid');
    assert.equal(chooseAutoLayout(2, { width: 1920, height: 1080 }), 'horizontal');
    assert.equal(chooseAutoLayout(2, { width: 1080, height: 1920 }), 'vertical');
    assert.equal(chooseAutoLayout(3, { width: 1920, height: 1080 }), 'main_stack');
    assert.equal(chooseAutoLayout(5, { width: 1920, height: 1080 }), 'grid');
});

test('grid layout honors a display with negative global coordinates', () => {
    const result = calculateChildWindowLayout('grid', 4, {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1040,
    }, { gap: 8 });
    assert.equal(result.bounds.length, 4);
    assert.ok(result.bounds.every(bounds => bounds.x >= -1920 && bounds.x + bounds.width <= 0));
    assert.ok(result.bounds.every(bounds => bounds.y >= 0 && bounds.y + bounds.height <= 1040));
});

test('adaptive grid uses a compact three-by-two layout for five landscape windows', () => {
    const result = calculateChildWindowLayout('grid', 5, {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    }, { gap: 0 });
    assert.deepEqual(result.bounds.slice(0, 3).map(bounds => bounds.y), [0, 0, 0]);
    assert.equal(result.bounds[3].y, 540);
});

test('all supported layouts produce one usable rectangle per window', () => {
    const layouts = ['cascade', 'grid', 'horizontal', 'vertical', 'rows', 'columns', 'main_stack'];
    for (const layout of layouts) {
        const result = calculateChildWindowLayout(layout, 5, {
            x: 0,
            y: 24,
            width: 2560,
            height: 1416,
        }, { gap: 10, rows: 2, columns: 3 });
        assert.equal(result.bounds.length, 5, layout);
        assert.ok(result.bounds.every(bounds => bounds.width > 0 && bounds.height > 0), layout);
    }
});

test('clamp keeps moved and resized windows inside the selected work area', () => {
    assert.deepEqual(
        clampBoundsToWorkArea(
            { x: 9999, y: -9999, width: 4000, height: 100 },
            { x: 1920, y: -100, width: 1920, height: 1080 },
            { width: 640, height: 480 },
        ),
        { x: 1920, y: -100, width: 1920, height: 480 },
    );
});
