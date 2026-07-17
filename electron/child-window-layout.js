const CHILD_WINDOW_LAYOUTS = Object.freeze([
    'auto',
    'cascade',
    'grid',
    'horizontal',
    'vertical',
    'rows',
    'columns',
    'main_stack',
]);

function positiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const number = Math.round(Number(value));
    return Number.isFinite(number)
        ? Math.min(max, Math.max(min, number))
        : fallback;
}

function normalizeWorkArea(workArea) {
    return {
        x: Math.round(Number(workArea?.x) || 0),
        y: Math.round(Number(workArea?.y) || 0),
        width: positiveInteger(workArea?.width, 1),
        height: positiveInteger(workArea?.height, 1),
    };
}

function chooseAutoLayout(count, workArea) {
    const total = positiveInteger(count, 0, 0);
    const area = normalizeWorkArea(workArea);
    if (total <= 1) return 'grid';
    if (total === 2) return area.width >= area.height ? 'horizontal' : 'vertical';
    if (total === 3) return 'main_stack';
    return 'grid';
}

function splitAxis(start, size, parts, gap) {
    const safeParts = positiveInteger(parts, 1);
    const safeGap = positiveInteger(gap, 0, 0, Math.max(0, size - 1));
    const usable = Math.max(safeParts, size - safeGap * (safeParts - 1));
    const base = Math.floor(usable / safeParts);
    let remainder = usable - base * safeParts;
    const segments = [];
    let cursor = start;
    for (let index = 0; index < safeParts; index += 1) {
        const segmentSize = base + (remainder > 0 ? 1 : 0);
        remainder = Math.max(0, remainder - 1);
        segments.push({ start: cursor, size: segmentSize });
        cursor += segmentSize + safeGap;
    }
    return segments;
}

function gridBounds(count, workArea, rows, columns, gap) {
    const area = normalizeWorkArea(workArea);
    const total = positiveInteger(count, 0, 0);
    if (total === 0) return [];

    let columnCount = positiveInteger(columns, 0, 0);
    let rowCount = positiveInteger(rows, 0, 0);
    if (!columnCount && !rowCount) {
        columnCount = Math.max(1, Math.round(Math.sqrt(total * area.width / area.height)));
        rowCount = Math.ceil(total / columnCount);
    } else if (!columnCount) {
        columnCount = Math.ceil(total / rowCount);
    } else if (!rowCount) {
        rowCount = Math.ceil(total / columnCount);
    }
    while (rowCount * columnCount < total) rowCount += 1;

    const xs = splitAxis(area.x, area.width, columnCount, gap);
    const ys = splitAxis(area.y, area.height, rowCount, gap);
    return Array.from({ length: total }, (_unused, index) => {
        const column = index % columnCount;
        const row = Math.floor(index / columnCount);
        return {
            x: xs[column].start,
            y: ys[row].start,
            width: xs[column].size,
            height: ys[row].size,
        };
    });
}

function cascadeBounds(count, workArea, gap, cascadeOffset) {
    const area = normalizeWorkArea(workArea);
    const total = positiveInteger(count, 0, 0);
    if (total === 0) return [];
    const offset = positiveInteger(cascadeOffset, 32, 8, 160);
    const padding = positiveInteger(gap, 8, 0, 80);
    const maxShift = offset * Math.max(0, total - 1);
    const width = Math.max(1, Math.min(area.width - padding * 2, Math.round(area.width * 0.72)));
    const height = Math.max(1, Math.min(area.height - padding * 2, Math.round(area.height * 0.72)));
    const availableShiftX = Math.max(0, area.width - width - padding * 2);
    const availableShiftY = Math.max(0, area.height - height - padding * 2);
    const shiftX = maxShift > 0 ? Math.min(offset, availableShiftX / (total - 1)) : 0;
    const shiftY = maxShift > 0 ? Math.min(offset, availableShiftY / (total - 1)) : 0;
    return Array.from({ length: total }, (_unused, index) => ({
        x: Math.round(area.x + padding + shiftX * index),
        y: Math.round(area.y + padding + shiftY * index),
        width,
        height,
    }));
}

function mainStackBounds(count, workArea, gap, mainRatio) {
    const area = normalizeWorkArea(workArea);
    const total = positiveInteger(count, 0, 0);
    if (total <= 1) return gridBounds(total, area, 1, 1, gap);
    const ratio = Math.min(0.8, Math.max(0.5, Number(mainRatio) || 0.62));
    const safeGap = positiveInteger(gap, 8, 0, 80);
    if (area.width >= area.height) {
        const mainWidth = Math.round((area.width - safeGap) * ratio);
        const sideWidth = area.width - safeGap - mainWidth;
        return [
            { x: area.x, y: area.y, width: mainWidth, height: area.height },
            ...splitAxis(area.y, area.height, total - 1, safeGap).map(segment => ({
                x: area.x + mainWidth + safeGap,
                y: segment.start,
                width: sideWidth,
                height: segment.size,
            })),
        ];
    }
    const mainHeight = Math.round((area.height - safeGap) * ratio);
    const sideHeight = area.height - safeGap - mainHeight;
    return [
        { x: area.x, y: area.y, width: area.width, height: mainHeight },
        ...splitAxis(area.x, area.width, total - 1, safeGap).map(segment => ({
            x: segment.start,
            y: area.y + mainHeight + safeGap,
            width: segment.size,
            height: sideHeight,
        })),
    ];
}

function calculateChildWindowLayout(layout, count, workArea, options = {}) {
    const requestedLayout = CHILD_WINDOW_LAYOUTS.includes(layout) ? layout : 'auto';
    const resolvedLayout = requestedLayout === 'auto'
        ? chooseAutoLayout(count, workArea)
        : requestedLayout;
    const gap = positiveInteger(options.gap, 8, 0, 80);
    let bounds;
    switch (resolvedLayout) {
        case 'cascade':
            bounds = cascadeBounds(count, workArea, gap, options.cascadeOffset);
            break;
        case 'horizontal':
            bounds = gridBounds(count, workArea, 1, count, gap);
            break;
        case 'vertical':
            bounds = gridBounds(count, workArea, count, 1, gap);
            break;
        case 'rows':
            bounds = gridBounds(count, workArea, options.rows || 2, 0, gap);
            break;
        case 'columns':
            bounds = gridBounds(count, workArea, 0, options.columns || 2, gap);
            break;
        case 'main_stack':
            bounds = mainStackBounds(count, workArea, gap, options.mainRatio);
            break;
        case 'grid':
        default:
            bounds = gridBounds(count, workArea, options.rows, options.columns, gap);
            break;
    }
    return { requestedLayout, resolvedLayout, bounds };
}

function clampBoundsToWorkArea(bounds, workArea, minimumSize = {}) {
    const area = normalizeWorkArea(workArea);
    const minWidth = Math.min(area.width, positiveInteger(minimumSize.width, 1));
    const minHeight = Math.min(area.height, positiveInteger(minimumSize.height, 1));
    const width = Math.min(area.width, positiveInteger(bounds?.width, minWidth, minWidth));
    const height = Math.min(area.height, positiveInteger(bounds?.height, minHeight, minHeight));
    const x = Math.min(area.x + area.width - width, Math.max(area.x, Math.round(Number(bounds?.x) || 0)));
    const y = Math.min(area.y + area.height - height, Math.max(area.y, Math.round(Number(bounds?.y) || 0)));
    return { x, y, width, height };
}

module.exports = {
    CHILD_WINDOW_LAYOUTS,
    calculateChildWindowLayout,
    chooseAutoLayout,
    clampBoundsToWorkArea,
};
