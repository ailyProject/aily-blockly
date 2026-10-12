const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../e2e/.artifacts/blockly-performance-2026-09-28');
const labels = process.argv.slice(2);
if (!labels.length) labels.push('before', 'after');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const metrics = {
  load: result => result.reload.synchronousMs,
  loadPaint: result => result.reload.paintedMs,
  drag: result => result.dragMs,
  redraw: result => result.redraw.synchronousMs,
  redrawPaint: result => result.redraw.paintedMs,
  projectOpen: result => result.projectOpenMs,
};
const summary = [];
console.log('| Label | Topology | Variant | Runs | Load | Load + paint | Drag | Redraw | Redraw + paint |');
console.log('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const label of labels) for (const topology of ['spread', 'stack']) for (const variant of ['official', 'aily', 'aily-ui', 'host']) {
  const prefix = `${label}-${variant}-${topology}-`;
  const runs = fs.readdirSync(directory).filter(name => name.startsWith(prefix) && /^\d+\.json$/.test(name.slice(prefix.length)))
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
  if (!runs.length) continue;
  if (runs.some(run => !run.passed || run.failure || run.environment?.count !== 8285 || !run.redraw?.statePreserved)) {
    throw new Error(`Incomplete or invalid benchmark: ${prefix}`);
  }
  const result = {label, topology, variant, runs: runs.length};
  for (const [name, read] of Object.entries(metrics)) {
    const values = runs.map(read).filter(Number.isFinite);
    if (values.length) result[name] = {median: median(values), min: Math.min(...values), max: Math.max(...values)};
  }
  summary.push(result);
  console.log(`| ${label} | ${topology} | ${variant} | ${runs.length} | ${['load', 'loadPaint', 'drag', 'redraw', 'redrawPaint'].map(name => Math.round(result[name].median)).join(' | ')} |`);
}
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
