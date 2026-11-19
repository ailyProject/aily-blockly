import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyCoderProjectPackageConfig, copyCoderArduinoTemplate } from '../../../src/app/services/domains/project/coder/coder-project-template.ts';

// Editor lifecycle fixtures, not compiler/SDK fixtures. Copy actual board
// definitions, templates and libraries; omit compiler installation metadata so
// this UI test never installs SDKs or touches the user's shared toolchains.
export async function installSimulatorProjects({ hostRoot, appRoot, index, output, developmentMode, writeJson }) {
  if (process.env.SIMULATOR_PRODUCT_PROJECTS !== '1') return null;
  const boards = path.resolve(hostRoot, '../aily-blockly-boards');
  const libraries = path.resolve(hostRoot, '../aily-blockly-libraries');
  const projects = ['xiao_esp32s3', 'arduino_uno'].map((board, number) => {
    const source = path.join(boards, board);
    const root = path.join(output, 'projects', `lifecycle-${number}`);
    const template = path.join(source, developmentMode === 'coder' ? 'template_arduino' : 'template');
    const manifest = JSON.parse(fs.readFileSync(path.join(template, 'package.json')));
    if (developmentMode === 'coder') {
      copyCoderArduinoTemplate(template, root, { join: path.join, isExists: fs.existsSync }, {
        mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, copySync: fs.copyFileSync,
      });
      const boardPackage = `@aily-project/board-${board}`;
      applyCoderProjectPackageConfig(manifest, boardPackage, manifest.dependencies[boardPackage]);
    } else fs.cpSync(template, root, { recursive: true });
    manifest.name = `simulator-lifecycle-${number}`;
    manifest.devmode = 'arduino';
    const pending = Object.keys(manifest.dependencies), installed = new Set();
    for (const name of pending) {
      if (installed.has(name)) continue;
      installed.add(name);
      const packageSource = name.startsWith('@aily-project/board-') ? source
        : path.join(libraries, name.replace('@aily-project/lib-', ''));
      const destination = path.join(root, 'node_modules', name);
      fs.cpSync(packageSource, destination, { recursive: true,
        filter: file => !path.relative(packageSource, file).split(path.sep).includes('node_modules') });
      const metadata = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')));
      if (name.startsWith('@aily-project/board-')) {
        metadata.boardDependencies = {};
        writeJson(path.join(destination, 'package.json'), metadata);
      } else pending.push(...Object.keys(metadata.dependencies || {}).filter(name => name.startsWith('@aily-project/lib-')));
    }
    writeJson(path.join(root, 'package.json'), manifest);
    return { path: root, boardPackage: `@aily-project/board-${board}` };
  });
  if (developmentMode === 'coder') {
    const editor = path.resolve(hostRoot, '../aily-coder-editor');
    const manifest = JSON.parse(fs.readFileSync(path.join(editor, 'package.json')));
    const destination = path.join(appRoot, 'node_modules', manifest.name);
    for (const entry of ['index.js', 'runtime', 'ui', 'i18n', 'agent', 'skill']) {
      assert.ok(fs.existsSync(path.join(editor, entry)), `Build the Coder editor first: ${entry}`);
      fs.cpSync(path.join(editor, entry), path.join(destination, entry), { recursive: true });
    }
    writeJson(path.join(destination, 'package.json'), manifest);
    index['aily-coder-editor'] = { ...manifest.ailySubapp, version: manifest.version,
      app: { ...manifest.ailySubapp.app, autoInstall: false } };
  }
  // Exercise the normal npm board-switch path against a bounded loopback
  // registry. Only transport/package fixtures are substituted, not lifecycle,
  // dependency installation, editor reload, board resolution or Agent ownership.
  const tar = createRequire(path.join(hostRoot, 'package.json'))('tar');
  const packages = new Map(), archives = new Map();
  const archiveRoot = path.join(output, 'registry');
  fs.mkdirSync(archiveRoot);
  for (const project of projects) {
    const scope = path.join(project.path, 'node_modules/@aily-project');
    for (const directory of fs.readdirSync(scope)) {
      const source = path.join(scope, directory);
      const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
      if (packages.has(manifest.name)) continue;
      const route = `/registry/${packages.size}.tgz`, archive = path.join(archiveRoot, `${packages.size}.tgz`);
      await tar.c({ cwd: source, file: archive, gzip: true, prefix: 'package/' }, fs.readdirSync(source));
      packages.set(manifest.name, { manifest, route });
      archives.set(route, archive);
    }
  }
  return { projects, serve(request, response) {
    const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (archives.has(route)) {
      response.setHeader('content-type', 'application/octet-stream');
      fs.createReadStream(archives.get(route)).pipe(response); return true;
    }
    const item = packages.get(route.slice(1));
    if (item) {
      const manifest = { ...item.manifest, dist: { tarball: `http://127.0.0.1:${request.socket.localPort}${item.route}` } };
      response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: manifest } }));
      return true;
    }
    if (/\/(boards|libraries|tags)(-linux)?\.json$/.test(route)) {
      const kind = route === '/boards.json' ? 'board-' : route === '/libraries.json' ? 'lib-' : null;
      response.end(JSON.stringify(kind ? [...packages.values()].filter(item => item.manifest.name.startsWith(`@aily-project/${kind}`))
        .map(item => ({ ...item.manifest, mode: ['arduino'] })) : []));
      return true;
    }
    if (route.startsWith('/@aily-project/') || route.startsWith('/registry/')) {
      response.statusCode = 404; response.end(JSON.stringify({ error: 'Package not part of lifecycle fixture' })); return true;
    }
    return false;
  } };
}

export async function openSimulatorProject({ project, command, until, writeJson, output, label }) {
  const opened = await command('project_open', {}, { path: project.path, timeoutMs: 120000 });
  writeJson(path.join(output, `project-${label}-open.json`), opened);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const ready = await until(async () => {
    const result = await command('project_load_status', {}, { path: project.path });
    return result.ready && result;
  }, `actual editor ready: ${label}`, 60000);
  const board = await command('get_board_config', { section: 'pins' });
  assert.equal(board.ok, true, JSON.stringify(board));
  assert.equal(board.boardPackage, project.boardPackage);
  assert.equal(path.resolve(board.project), path.resolve(project.path));
  writeJson(path.join(output, `project-${label}-ready.json`), { ready, board });
  return { ready, board };
}

export function readSimulatorProjection(main, sessionId, action = 'snapshot', runId) {
  return main.evaluate(input => window.electronAPI.childToolSession.observeNative(input),
    { toolId: 'simulator-debugger', action, sessionId, ...(runId ? { runId } : {}) });
}

export async function verifySimulatorProjectSwitch({ projects, main, sessionId, command, until, writeJson, output, report }) {
  const before = await readSimulatorProjection(main, sessionId);
  assert.equal(before.ok, true);
  assert.equal(before.snapshot.outcome, 'running');
  assert.ok(before.snapshot.runId);
  assert.equal(before.snapshot.firmware?.target, 'esp32s3');
  const selected = await openSimulatorProject({ project: projects[1], command, until, writeJson, output, label: 'switched' });
  const after = await readSimulatorProjection(main, sessionId);
  assert.equal(after.snapshot.runId, before.snapshot.runId);
  assert.equal(after.snapshot.outcome, 'running', 'Changing the editor cannot stop the selected firmware');
  assert.equal(after.snapshot.canStop, true);
  assert.deepEqual(after.snapshot.firmware, before.snapshot.firmware);
  const compact = main.frameLocator('.subapp-dock app-child-tool-native-observer iframe');
  assert.match(await compact.locator('#firmware-target').innerText(), /esp32s3/);
  await main.screenshot({ path: path.join(output, 'project-switch-live.png') });
  const unrelated = await readSimulatorProjection(main, 'unrelated-session');
  assert.equal(unrelated.snapshot.outcome, 'idle');
  const rejectedStop = await readSimulatorProjection(main, 'unrelated-session', 'stop', before.snapshot.runId);
  assert.equal(rejectedStop.ok, false, 'Another session must not stop this batch');
  const stillRunning = await readSimulatorProjection(main, sessionId);
  assert.equal(stillRunning.snapshot.outcome, 'running');
  writeJson(path.join(output, 'project-switch-during-debug.json'), { before, selected, after, unrelated, rejectedStop });
  report.checks.push('active-chat-real-editor-project-and-board-change-preserves-run', 'project-switch-preserves-observer-owner-and-stop-isolation');
  const abiPath = path.join(projects[1].path, 'project.abi');
  const readSource = fs.existsSync(abiPath)
    ? () => {
      const document = JSON.parse(fs.readFileSync(abiPath));
      // Saving a board template wraps its workspace in the current page
      // container. Compare the actual blocks, not this expected schema upgrade.
      const workspaces = document.pages ? document.pages.map(page => page.content) : [document];
      assert.ok(workspaces.length && workspaces.every(workspace => workspace.blocks));
      return workspaces.map(workspace => workspace.blocks);
    }
    : () => fs.readFileSync(path.join(projects[1].path, 'sketch/src/main.cpp'), 'utf8');
  const originalSource = readSource();
  const switched = await command('board_switch', { boardName: projects[0].boardPackage }, { timeoutMs: 120000 });
  writeJson(path.join(output, 'board-switch-during-debug.json'), switched);
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(switched.changed, true);
  assert.equal(switched.ready, true);
  assert.deepEqual(readSource(), originalSource, 'Switching boards must preserve the test project source');
  assert.equal(path.resolve(switched.project), path.resolve(projects[1].path));
  const board = await command('get_board_config', { section: 'pins' });
  assert.equal(board.boardPackage, projects[0].boardPackage);
  const afterBoard = await readSimulatorProjection(main, sessionId);
  assert.equal(afterBoard.snapshot.runId, before.snapshot.runId);
  assert.equal(afterBoard.snapshot.outcome, 'running');
  assert.deepEqual(afterBoard.snapshot.firmware, before.snapshot.firmware);
  writeJson(path.join(output, 'board-switch-debug-projection.json'), { board, afterBoard });
  report.checks.push('same-project-board-switch-with-live-chat-and-qemu');
}
