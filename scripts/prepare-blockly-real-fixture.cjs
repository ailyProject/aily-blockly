// Private data stays in ignored artifacts. Never open the source in a test.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const out = path.resolve(__dirname, '../e2e/.artifacts/blockly-real-project-2026-09-28');
const read = name => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function blocks(state) {
  const result = [], pending = [...state.blocks.blocks];
  while (pending.length) {
    const block = pending.pop(); result.push(block);
    for (const connection of [...Object.values(block.inputs || {}), block.next]) {
      const child = connection?.block || connection?.shadow;
      if (child) pending.push(child);
    }
  }
  return result;
}
function fixture(source) {
  if (!source) throw new Error('Supply the absolute path to an installed project');
  source = fs.realpathSync(source);
  const dest = path.join(out, 'project');
  if (fs.existsSync(dest)) throw new Error(`Preserve/move the existing fixture before recreating: ${dest}`);
  const hashes = {};
  for (const name of ['package.json', 'package-lock.json', 'project.abi', 'project.abs']) {
    if (fs.existsSync(path.join(source, name))) hashes[name] = hash(path.join(source, name));
  }
  write('source-hashes.json', hashes);
  // Dereference installed library links into the copy, so changing its board
  // manifest cannot follow a symlink back to the user's source libraries.
  fs.cpSync(source, dest, {recursive: true, dereference: true, filter: file =>
    !['.git', '.temp', '.build', 'build', '.log', '.aily', '.workspace-history', 'project-open.lock'].includes(path.basename(file))});
  const manifest = read('project/package.json');
  for (const [name, entry] of Object.entries(manifest.ailyBlocklyUsedLibraries || {})) {
    if (entry.localPath) entry.localPath = path.join(dest, 'local-libraries', name);
  }
  write('project/package.json', manifest);
  for (const name of Object.keys(manifest.dependencies || {}).filter(name => name.startsWith('@aily-project/board-'))) {
    const file = path.join(dest, 'node_modules', name, 'package.json');
    if (!fs.realpathSync(file).startsWith(dest + path.sep)) throw new Error('Board manifest escaped private fixture');
    const board = JSON.parse(fs.readFileSync(file));
    board.boardDependencies = {}; // Rendering/editing benchmark, no compiler downloads.
    fs.writeFileSync(file, JSON.stringify(board));
  }
  const state = read('project/project.abi'), all = blocks(state), types = {};
  for (const block of all) types[block.type] = (types[block.type] || 0) + 1;
  write('source-statistics.json', {source, count: all.length, variables: state.variables?.length || 0, types, hashes, compilerDownloadsExcluded: true});
}
function expand() {
  const capture = read('capture.json'), state = capture.state, all = blocks(state);
  const original = all.length;
  const template = {...all.find(block => block.type === 'lvgl_label_set_text' && block.inputs?.TEXT?.block?.type === 'text')};
  if (!template.type) throw new Error('No real LVGL label-text subtree found');
  delete template.next;
  const size = blocks({blocks: {blocks: [template]}}).length;
  const setup = all.find(block => block.type === 'arduino_setup');
  let tail = setup.inputs.ARDUINO_SETUP.block;
  while (tail.next?.block) tail = tail.next.block;
  const ids = new Set(all.map(block => block.id));
  let count = original, sequence = 0;
  while (count < 8265) {
    const block = JSON.parse(JSON.stringify(template));
    for (const child of blocks({blocks: {blocks: [block]}})) {
      do {child.id = `real-stress-${sequence++}`;} while (ids.has(child.id));
      ids.add(child.id);
    }
    tail.next = {block}; tail = block; count += size;
  }
  write('expanded.json', state);
  fs.cpSync(path.join(out, 'project'), path.join(out, 'project-expanded'), {recursive: true, dereference: true});
  write('project-expanded/project.abi', state);
  write('expansion.json', {original, expanded: count, templateId: template.id, type: template.type,
    templateBlockCount: size, added: count - original,
    description: 'Duplicate a real LVGL label-text subtree at the end of setup; retain variable references and assign fresh IDs.'});
}
function verify() {
  const {source} = read('source-statistics.json');
  for (const [name, expected] of Object.entries(read('source-hashes.json'))) {
    if (hash(path.join(source, name)) !== expected) throw new Error(`Original project changed: ${name}`);
  }
  console.log('Original project file hashes unchanged.');
}
try {
  fs.mkdirSync(out, {recursive: true});
  if (process.argv[2] === 'fixture') fixture(process.argv[3]);
  else if (process.argv[2] === 'expand') expand();
  else if (process.argv[2] === 'verify') verify();
  else throw new Error('Expected fixture <project>, expand, or verify');
} catch (error) {console.error(error); process.exitCode = 1;}
