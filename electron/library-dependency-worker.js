// Executed by the bundled Node, with npm's own config and dependency resolver.
// The request/result travel over pipes; no project draft files are created.
async function run(request) {
  const path = require('node:path');
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
      savePrefix: '', packageLockOnly: request.save === true, foregroundScripts: true };
    const arb = new Arborist(options);
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
    result => { process.send({ ok: true, ...result }); process.disconnect(); },
    error => { process.send({ ok: false, error: error.message }); process.disconnect(); process.exitCode = 1; },
  ));
}
