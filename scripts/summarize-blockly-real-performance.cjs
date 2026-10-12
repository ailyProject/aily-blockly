const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '../e2e/.artifacts/blockly-real-project-2026-09-28');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [];
for (const topology of ['original', 'expanded']) {
  const contract = read(`contract-${topology}.json`);
  assert.equal(contract.passed, true, 'Real editor/save contract must pass');
  const groups = [['healthy-before', 'host'], ['after', 'host'], ['after', 'official'], ['after', 'aily-ui']];
  let hostGeometry;
  for (const [label, variant] of groups) {
    const records = [1, 2, 3].map(round => read(`${label}-${variant}-${topology}-${round}.json`));
    for (const record of records) {
      assert.equal(record.passed, true, `${label}/${variant}/${topology}: not a completed run`);
      assert.deepEqual(record.errors, []);
      assert.equal(record.environment.count, contract.before.count);
      assert.equal(record.environment.version, '13.3.0');
      assert.deepEqual(record.environment.viewport, {width: 1440, height: 800, devicePixelRatio: 2});
      assert.equal(record.codeSha256, contract.codeSha256, 'Code differs from the real saved/reopened project');
      assert.equal(record.codePreserved, true);
      if (variant === 'host') {
        hostGeometry ??= record.geometrySha256;
        assert.equal(record.geometrySha256, hostGeometry, 'Host block/field geometry changed');
      }
      if (variant === 'aily-ui') assert.equal(record.geometrySha256, hostGeometry, 'Independent Aily UI geometry differs from host');
    }
    const metric = get => {
      const values = records.map(get);
      if (values.some(value => typeof value !== 'number')) return null;
      return {medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values)};
    };
    summary.push({label, variant, topology, count: contract.before.count, rounds: records.length,
      codeSha256: contract.codeSha256, geometrySha256: records[0].geometrySha256,
      projectVisible: metric(record => record.projectReadyMs),
      projectAndMinimap: metric(record => record.projectAndMinimapMs),
      initialNativeLoad: metric(record => record.initialNativeLoads?.filter(load => load.count === contract.before.count).at(-1)?.ms),
      standaloneInitial: metric(record => record.initial?.paintedMs),
      nativeReload: metric(record => record.reload.paintedMs),
      drag: metric(record => record.dragMs),
      largestFrameGap: metric(record => Math.max(...record.after.sample.frames)),
      largestLongTask: metric(record => Math.max(...record.after.sample.longTasks)),
      redraw: metric(record => record.redraw.paintedMs)});
  }
}
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
for (const row of summary) console.log(JSON.stringify(row));
