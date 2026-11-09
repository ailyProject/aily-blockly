// Executed by the bundled Node, with npm's own config and dependency resolver.
// The request/result travel over pipes; the main dependency manager owns archives.
let checkpointDisconnect;
async function run(request) {
  const path = require('node:path');
  const checkpoint = async (locations, writes) => {
    if (!request.environmentCheckpoint) return;
    const token = require('node:crypto').randomUUID();
    await new Promise((resolve, reject) => {
      const receive = value => {
        if (value?.type !== 'environment-checkpoint-ack' || value.token !== token) return;
        process.removeListener('message', receive);
        value.ok ? resolve() : reject(new Error(value.error || 'Environment preservation failed'));
      };
      process.on('message', receive);
      process.send({ type: 'environment-before-reify', token, locations, ...(writes ? { writes } : {}) });
    });
  };
  if (request.environmentCheckpoint) {
    checkpointDisconnect = () => process.exit(1);
    process.once('disconnect', checkpointDisconnect);
    // npm destructures this builtin before constructing its actual writers.
    // Preserve their exact original input-write intent before delegating; no
    // package/body text is emitted to diagnostics or returned to the model.
    const promises = require('node:fs/promises'), write = promises.writeFile;
    promises.writeFile = async (file, bytes, ...args) => {
      const relative = typeof file === 'string' ? path.relative(process.cwd(), path.resolve(file)).replace(/\\/g, '/') : '';
      if (['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'node_modules/.package-lock.json'].includes(relative)) {
        const content = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : typeof bytes === 'string' ? bytes : null;
        if (content === null) throw new Error('Unsupported managed dependency input encoding');
        await checkpoint([], { [relative]: content });
      }
      return write.call(promises, file, bytes, ...args);
    };
  }
  if (request.materializeSources) {
    const fs = require('node:fs');
    const { collectLibraryPackages, extractLibrarySourceArchive, createLibrarySourceFingerprint } = require(request.preprocessPath);
    const manifest = request.manifest;
    const dependencies = Object.assign({}, ...['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].map(field => manifest[field]));
    const libraries = collectLibraryPackages(dependencies, process.cwd());
    const expansions = libraries.filter(library => !fs.existsSync(path.join(library.packagePath, 'src')) && fs.existsSync(path.join(library.packagePath, 'src.7z')));
    if (expansions.length) await checkpoint(expansions.map(library => path.posix.join('node_modules', library.packageName)));
    for (const library of libraries) {
      const source = path.join(library.packagePath, 'src');
      const archive = path.join(library.packagePath, 'src.7z');
      if (!fs.existsSync(source) && fs.existsSync(archive)) {
        try { extractLibrarySourceArchive(request.extractor, archive, source); }
        catch (error) { throw new Error(`库 ${library.packageName} 解压失败: ${error.message}`); }
      }
      if (fs.existsSync(source)) {
        if (!fs.statSync(source).isDirectory() || !fs.readdirSync(source).length) {
          throw new Error(`库 ${library.packageName} 的 src 目录不完整`);
        }
        createLibrarySourceFingerprint(source);
      }
    }
    return { manifest };
  }
  const Arborist = require(path.join(request.npmRoot, 'node_modules/@npmcli/arborist'));
  const npa = require(path.join(request.npmRoot, 'node_modules/npm-package-arg'));
  if (request.reconcileOnly && !request.save && !request.add?.length && !request.remove?.length && !request.install?.length) {
    const manifest = await readUnchangedDependencyTree(Arborist, npa);
    if (manifest) return { manifest, unchanged: true };
  }
  const Npm = require(path.join(request.npmRoot, 'lib/npm.js'));
  // node -e has no script argument. npm config expects argv[0:2] to be
  // executable/script, otherwise it drops the install command.
  process.argv = [process.execPath, 'npm'];
  const npm = new Npm({ argv: ['install', '--no-audit', '--no-fund', '--foreground-scripts'] });
  try {
    await npm.load();
    const additions = new Map((request.add || []).map(spec => [npa(spec).name, spec]));
    for (const spec of request.install || []) additions.set(npa(spec).name, spec);
    const options = { ...npm.flatOptions, ...request.options, path: process.cwd(),
      global: false, workspaces: false, audit: false, fund: false,
      ...(request.reconcileOnly ? { forceActual: true } : {}),
      add: [...additions.values()], rm: (request.remove || []).filter(name => !additions.has(name)), save: request.save === true,
      savePrefix: '', packageLockOnly: request.save === true, foregroundScripts: true,
      // Managed changes promise a bounded filesystem mutation set. Arbitrary
      // lifecycle scripts cannot participate in that promise; source expansion
      // remains the explicit, checkpointed materializeSources operation above.
      ...(request.environmentCheckpoint ? { ignoreScripts: true } : {}) };
    const arb = new Arborist(options);
    if (request.environmentCheckpoint) {
      const actual = await arb.loadActual({ forceActual: true });
      const ideal = await arb.buildIdealTree(options);
      const identity = node => JSON.stringify([node.version, node.resolved, node.integrity,
        node.isLink, node.realpath, node.package?.dependencies, node.package?.optionalDependencies]);
      const locations = new Set();
      const retainBins = node => {
        const bins = typeof node?.package?.bin === 'string' ? [node.name.split('/').pop()] : Object.keys(node?.package?.bin || {});
        for (const name of bins) for (const suffix of process.platform === 'win32' ? ['', '.cmd', '.ps1'] : ['']) {
          locations.add(`node_modules/.bin/${name}${suffix}`);
        }
      };
      for (const [location, node] of actual.inventory) {
        if (!location || !location.startsWith('node_modules/')) continue;
        const target = ideal.inventory.get(location);
        if (request.reconcileOnly && node.extraneous || !target || identity(node) !== identity(target)
          || additions.has(node.name)) { locations.add(location); retainBins(node); retainBins(target); }
      }
      for (const [location, node] of ideal.inventory) {
        if (location?.startsWith('node_modules/') && !actual.inventory.has(location)) { locations.add(location); retainBins(node); }
      }
      await checkpoint([...locations].sort());
    }
    // Without a root lockfile, plain reify can retain packages recorded by the
    // hidden lockfile after an interrupted edit. A clean reopen must prune them.
    if (request.reconcileOnly) await arb.prune(options);
    else await arb.reify(options);
    const tree = arb.actualTree || arb.idealTree;
    const manifest = JSON.parse(JSON.stringify(tree.package));
    delete manifest._id;
    if (!request.save) for (const name of additions.keys()) {
      // npm accepts a dangling file: link as a successful reify. The library
      // manager must not acknowledge a package that cannot actually be loaded.
      const node = tree.children.get(name);
      const file = node && path.join(node.path, 'package.json');
      if (!file || !require('node:fs').existsSync(file)) throw new Error(`Installed library is missing package.json: ${name}`);
    }
    // Preserve file/link specs, but pin newly resolved registry versions so a
    // later operation/save cannot silently upgrade an unsaved installation.
    for (const name of additions.keys()) {
      const node = tree.children.get(name);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const spec = manifest[field]?.[name];
        if (spec && node?.version && npa.resolve(name, spec).registry) manifest[field][name] = node.version;
      }
    }
    return { manifest };
  } finally { npm.unload(); }
}

/** Read actual manifests rather than trusting node_modules' cached lockfile.
 * Any ambiguity falls back to npm's existing reconciliation path. */
async function readUnchangedDependencyTree(Arborist, npa) {
  try {
    const options = { path: process.cwd(), workspaces: false };
    const tree = await new Arborist(options).loadActual({ forceActual: true });
    if (tree.package.workspaces || tree.package.overrides) return null;
    for (const node of tree.inventory.values()) {
      if (node.isLink || node.extraneous || node.errors.length || node.package.bin) return null;
      for (const edge of node.edgesOut.values()) {
        // Local directories, tarballs and Git sources can change without a
        // version change. Let npm decide how those must be reinstalled.
        const spec = npa.resolve(edge.name, edge.spec, node.path);
        if (!edge.valid || !['version', 'range'].includes(spec.type)) return null;
      }
    }
    const fs = require('node:fs');
    if (fs.existsSync('package-lock.json') || fs.existsSync('npm-shrinkwrap.json')) {
      const saved = await new Arborist(options).loadVirtual();
      if (saved.inventory.size !== tree.inventory.size) return null;
      for (const [location, node] of saved.inventory) {
        const actual = tree.inventory.get(location);
        if (!actual || node.isLink || node.version !== actual.version) return null;
        if (node.resolved !== actual.resolved || node.integrity !== actual.integrity) return null;
      }
    }
    const manifest = JSON.parse(JSON.stringify(tree.package));
    delete manifest._id;
    return manifest;
  } catch {
    return null;
  }
}

if (require.main === module || process.env.AILY_LIBRARY_WORKER === '1') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', value => { input += value; });
  process.stdin.on('end', () => run(JSON.parse(input)).then(
    result => {
      if (checkpointDisconnect) process.removeListener('disconnect', checkpointDisconnect);
      process.send({ ok: true, ...result }, () => process.disconnect());
    },
    error => {
      if (checkpointDisconnect) process.removeListener('disconnect', checkpointDisconnect);
      process.exitCode = 1;
      process.send({ ok: false, error: error.message }, () => process.disconnect());
    },
  ));
}
