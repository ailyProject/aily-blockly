'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isProjectWriterTransient } = require('./project-file-copy');

const OMIT = new Set(['node_modules', '.git', '.aily', '.temp', '.build', '.log', '.workspace-history',
  'project.abi', 'project.abs', 'project.abs.map.json', 'project.aci', 'package-lock.json',
  'npm-shrinkwrap.json', '.DS_Store']);
const SOURCE_FILE = /\.(?:ino|pde|c|cc|cpp|cxx|h|hpp|hh|hxx|s)$/i;

/** Turn Arduino tabs into the same persistent src/main.cpp workspace as a new Coder project. */
function convertSketchSources(sketch, entry) {
  const sources = new Map();
  const collect = (directory, prefix = '') => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isDirectory() && item.name !== 'libraries') collect(path.join(directory, item.name), `${relative}/`);
      else if (item.isFile() && SOURCE_FILE.test(item.name)) sources.set(relative, fs.readFileSync(path.join(sketch, relative), 'utf8'));
    }
  };
  collect(sketch);
  const tabs = [...sources.keys()].filter(name => !name.includes('/') && /\.(ino|pde)$/i.test(name)).sort();
  const primary = tabs.find(name => name.toLowerCase() === `${path.basename(path.dirname(entry))}.ino`.toLowerCase())
    || path.basename(entry);
  const orderedTabs = [primary, ...tabs.filter(name => name !== primary)];
  const destinations = new Map([...sources.keys()].map(name => [name,
    tabs.includes(name) ? 'src/main.cpp' : name.includes('/') ? name : `src/${name}`]));
  const occupied = new Set(['src/main.cpp']);
  for (const [name, destination] of destinations) {
    if (tabs.includes(name)) continue;
    // Never overwrite a user translation unit or flatten two distinct headers onto one file.
    if (occupied.has(destination)) throw new Error(`源文件重名，无法转换：${destination}`);
    occupied.add(destination);
  }
  const relocateIncludes = (content, from, to) => content.replace(
    /(^[\t ]*#[\t ]*include[\t ]*")([^"\r\n]+)(")/gm,
    (directive, before, include, after) => {
      const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(from), include));
      // Only adjust includes that resolve to a copied project file; library includes remain unchanged.
      const resolved = [candidate, path.posix.normalize(include)].find(file =>
        !file.startsWith('../') && !path.posix.isAbsolute(file) && fs.existsSync(path.join(sketch, file)));
      if (!resolved) return directive;
      const destination = destinations.get(resolved) || resolved;
      return before + path.posix.relative(path.posix.dirname(to), destination) + after;
    });
  // Resolve every include before deleting/moving any input files.
  const outputs = new Map();
  for (const [name, content] of sources) {
    if (!tabs.includes(name)) outputs.set(destinations.get(name), relocateIncludes(content, name, destinations.get(name)));
  }
  let main = orderedTabs.map(name => relocateIncludes(sources.get(name), name, 'src/main.cpp')).join('\n\n');
  main = main.replace(/^\uFEFF/, '');
  if (!/^[\t ]*#[\t ]*include\s*[<"]Arduino\.h[>"]/m.test(main)) main = `#include <Arduino.h>\n\n${main}`;
  outputs.set('src/main.cpp', main);
  for (const [name, destination] of destinations) {
    if (name !== destination) fs.rmSync(path.join(sketch, name));
  }
  for (const [name, content] of outputs) {
    fs.mkdirSync(path.dirname(path.join(sketch, name)), { recursive: true });
    fs.writeFileSync(path.join(sketch, name), content);
  }
}

/** Reserve a sibling project and copy source inputs, never the Blockly runtime or build cache. */
function convertBlocklyProjectToCoder(sourcePath, entryPath) {
  const source = fs.realpathSync(sourcePath);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (manifest.type === 'coder' || !fs.existsSync(path.join(source, 'project.abi'))) {
    throw new Error('请选择 Blockly 项目');
  }
  if (manifest.devmode && manifest.devmode !== 'arduino') throw new Error('仅支持转换 Arduino 项目');
  const entry = fs.realpathSync(entryPath || path.join(source, '.temp', 'sketch', 'sketch.ino'));
  const relativeEntry = path.relative(source, entry);
  if (!relativeEntry || relativeEntry === '..' || relativeEntry.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeEntry) || !/\.ino$/i.test(entry) || !fs.statSync(entry).isFile()) {
    throw new Error('Arduino 主文件必须位于 Blockly 项目中');
  }

  let target;
  const name = `${path.basename(source)}_coder`;
  for (let suffix = 0; ; suffix++) {
    target = path.join(path.dirname(source), suffix ? `${name}_${suffix}` : name);
    try { fs.mkdirSync(target); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try {
    const copyInputs = (from, to) => fs.cpSync(from, to, { recursive: true,
      filter: file => !OMIT.has(path.basename(file)) && !isProjectWriterTransient(path.relative(source, file)) });
    for (const item of fs.readdirSync(source)) {
      if (!OMIT.has(item) && item !== 'src' && item !== 'package.json' && !SOURCE_FILE.test(item)) {
        copyInputs(path.join(source, item), path.join(target, item));
      }
    }
    const sketch = path.join(target, 'sketch');
    fs.mkdirSync(sketch, { recursive: true });
    // Includes, secondary tabs and generated declarations travel with the entry.
    if (path.dirname(entry) !== source) copyInputs(path.dirname(entry), sketch);
    else {
      for (const item of fs.readdirSync(source, { withFileTypes: true })) {
        if (item.isFile() && (SOURCE_FILE.test(item.name) || /\.csv$/i.test(item.name))) {
          fs.copyFileSync(path.join(source, item.name), path.join(sketch, item.name));
        }
      }
    }
    if (fs.existsSync(path.join(source, 'src'))) copyInputs(path.join(source, 'src'), path.join(sketch, 'src'));
    fs.rmSync(path.join(sketch, 'package.json'), { force: true });
    fs.mkdirSync(path.join(sketch, 'libraries'), { recursive: true });
    convertSketchSources(sketch, entry);
    if (manifest.projectConfig?.PartitionScheme === 'custom') {
      const destination = path.join(sketch, 'src', 'partitions.csv');
      // Blockly can use a board-owned default without a project-local CSV.
      // Persist that input in the new Coder workspace; user files always win.
      const board = Object.keys({ ...manifest.dependencies, ...manifest.boardDependencies })
        .find(name => /^@aily-project(?:-coder)?\/(?:board-|coder-)/.test(name));
      const candidates = [destination, path.join(source, 'src', 'partitions.csv'),
        path.join(source, 'partitions.csv'), path.join(path.dirname(entry), 'partitions.csv'),
        ...(board ? [path.join(source, 'node_modules', board, 'partitions.csv')] : [])];
      const partition = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (partition && partition !== destination) fs.copyFileSync(partition, destination);
    }

    // Local dependencies must still resolve after moving the manifest to its new directory.
    let localIndex = 0;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'boardDependencies']) {
      for (const [dependency, spec] of Object.entries(manifest[group] || {})) {
        if (typeof spec !== 'string' || !/^(file|link):/.test(spec)) continue;
        const resolved = path.resolve(source, spec.slice(spec.indexOf(':') + 1));
        const relative = path.relative(source, resolved);
        let relocated = resolved;
        if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          relocated = path.join(target, relative);
          if (!fs.existsSync(relocated)) {
            relocated = path.join(target, 'local-dependencies', String(++localIndex), path.basename(resolved));
            fs.mkdirSync(path.dirname(relocated), { recursive: true });
            fs.cpSync(resolved, relocated, { recursive: true });
          }
        }
        manifest[group][dependency] = `file:${path.relative(target, relocated).split(path.sep).join('/') || '.'}`;
      }
    }
    for (const field of ['cloudId', 'codeHash', 'buildInfo', 'blocklyToolboxOrder', 'ailyBlocklyUsedLibraries',
      'coderBoardTemplateDependencies', 'arduinoSketch']) delete manifest[field];
    manifest.name = path.basename(target).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'coder-project';
    manifest.nickname = `${manifest.nickname || path.basename(source)} (Coder)`;
    manifest.private = true;
    manifest.type = 'coder';
    manifest.framework = manifest.devmode = 'arduino';
    manifest.entry = 'src/main.cpp';
    manifest.sourceRoots = ['src', 'libraries'];
    if (Object.hasOwn(manifest, 'path')) manifest.path = target;
    const boards = Object.fromEntries(Object.entries(manifest.dependencies || {})
      .filter(([name]) => /^@aily-project(?:-coder)?\/board-/.test(name)));
    manifest.boardDependencies = { ...manifest.boardDependencies, ...boards };
    // npm normally symlinks directory file: dependencies outside node_modules.
    // Coder resolves library sources within its project, so install actual copies
    // and retain that policy for later reinstall/board-switch operations.
    const npmrc = path.join(target, '.npmrc');
    const previousNpmrc = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf8') : '';
    fs.writeFileSync(npmrc, `${previousNpmrc.replace(/\n?$/, '\n')}install-links=true\n`);
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    return target;
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { convertBlocklyProjectToCoder };
