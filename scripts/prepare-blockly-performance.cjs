const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createRequire} = require('node:module');
const esbuild = createRequire(require.resolve('@angular/build/package.json'))('esbuild');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'e2e/.artifacts/blockly-performance-2026-09-28');
const seed = process.env.AILY_E2E_PROJECT || path.join(output, 'seed');

async function prepare() {
  fs.mkdirSync(output, {recursive: true});
  if (!process.env.AILY_E2E_PROJECT && !fs.existsSync(seed)) {
    fs.cpSync(path.join(root, 'e2e/fixtures/projects/esp32s3-debug'), seed, {recursive: true});
  }
  if (!fs.existsSync(path.join(seed, 'node_modules/@aily-project/lib-core-loop/block.json'))) {
    if (process.env.AILY_E2E_PROJECT) throw new Error('AILY_E2E_PROJECT must already contain installed block libraries.');
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: seed, stdio: 'inherit'});
  }
  const definitions = ['loop', 'time', 'math'].flatMap(name => JSON.parse(fs.readFileSync(
    path.join(seed, `node_modules/@aily-project/lib-core-${name}/block.json`), 'utf8')))
    .filter(block => ['arduino_global', 'arduino_setup', 'arduino_loop', 'controls_repeat_ext', 'time_delay', 'math_number'].includes(block.type));
  fs.writeFileSync(path.join(output, 'definitions.json'), JSON.stringify(definitions));
  for (const topology of ['spread', 'stack']) {
    const roots = ['global', 'setup', 'loop'].map((name, i) => ({
      type: `arduino_${name}`, id: `perf-${name}`, x: 40 + i * 360, y: 40,
    }));
    let previous;
    for (let group = 0; group < 41; group++) {
      const repeat = {type: 'controls_repeat_ext', id: `repeat-${group}`, x: 40 + (group % 8) * 360,
        y: 240 + Math.floor(group / 8) * 4500, inputs: {TIMES: {block: {
          type: 'math_number', id: `times-${group}`, fields: {NUM: 2},
        }}}};
      let tail;
      for (let i = 0; i < 100; i++) {
        const delay = {type: 'time_delay', id: `delay-${group}-${i}`, inputs: {DELAY_TIME: {block: {
          type: 'math_number', id: `number-${group}-${i}`, fields: {NUM: group * 100 + i + 1},
        }}}};
        if (tail) tail.next = {block: delay};
        else repeat.inputs.DO = {block: delay};
        tail = delay;
      }
      if (topology === 'spread') roots.push(repeat);
      else {
        delete repeat.x; delete repeat.y;
        if (previous) previous.next = {block: repeat};
        else roots[1].inputs = {ARDUINO_SETUP: {block: repeat}};
        previous = repeat;
      }
    }
    const state = {blocks: {languageVersion: 0, blocks: roots}};
    fs.writeFileSync(path.join(output, `${topology}.json`), JSON.stringify(state));
    const project = path.join(output, `project-${topology}`);
    if (!fs.existsSync(project)) fs.cpSync(seed, project, {recursive: true, filter: source =>
      !['.git', '.aily', '.build', '.temp', '.log', '.workspace-history', 'project-open.lock', 'project.abs', 'project.abs.map.json'].includes(path.basename(source))});
    // This generated fixture exercises rendering and editing, not compilation.
    // Keep all real block libraries but give its private board copy no compiler
    // downloads, so network/installation activity cannot contaminate timings.
    const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies || {}).filter(name => name.startsWith('@aily-project/board-'))) {
      const boardManifest = path.join(project, 'node_modules', name, 'package.json');
      const board = JSON.parse(fs.readFileSync(boardManifest, 'utf8'));
      board.boardDependencies = {};
      fs.writeFileSync(boardManifest, JSON.stringify(board, null, 2));
    }
    fs.writeFileSync(path.join(project, 'project.abi'), JSON.stringify(state, null, 2));
  }
  const official = path.join(output, 'official');
  fs.mkdirSync(official, {recursive: true});
  if (!fs.existsSync(path.join(official, 'blockly-13.3.0.tgz'))) {
    execFileSync('npm', ['pack', 'blockly@13.3.0', '--ignore-scripts', '--pack-destination', official], {stdio: 'inherit'});
  }
  execFileSync('tar', ['-xzf', path.join(official, 'blockly-13.3.0.tgz'), '-C', official]);
  for (const variant of ['aily', 'official', 'aily-ui']) {
    await esbuild.build({entryPoints: [path.join(root, 'e2e/performance/standalone.ts')],
      bundle: true, minify: true, platform: 'browser', target: 'es2022',
      alias: variant === 'official' ? {blockly: path.join(official, 'package')} : undefined,
      define: {AILY_RENDERER: String(variant === 'aily-ui')},
      outfile: path.join(output, `${variant}.js`)});
    fs.writeFileSync(path.join(output, `${variant}.html`), `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Blockly 13 · ${variant} · 8285 blocks</title><link rel="stylesheet" href="/fonts/fontawesome6/css/all.min.css">
      <style>html,body{margin:0;background:#262626;color:#eee;font:14px system-ui;height:100%}header{height:44px;display:flex;gap:24px;align-items:center;padding:0 20px}#workspace{position:absolute;inset:44px 0 0}button{padding:5px 12px}</style>
      <header><strong>Blockly 13 · ${variant}</strong><span>8285 块性能对照</span><button onclick="location.search='?topology=spread'">分散堆栈</button><button onclick="location.search='?topology=stack'">8283 后代整栈</button><span id="status">Loading…</span></header>
      <div id="workspace"></div><script src="${variant}.js"></script></html>`);
  }
  console.log(output);
}
prepare().catch(error => {console.error(error); process.exitCode = 1;});
