const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const waitForBlankProject = page => page.waitForFunction(() => {
  const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
  return component?.projectService.getBlocklyProjectLoadStatus(component.projectService.currentProjectPath)?.ready;
}, undefined, { timeout: 90000 });

/** Copy installed dependencies and the actual board template, never pre-seed models/blocks. */
async function openBlankProject(page, source, parent, title, libraries = []) {
  const previousProject = await page.evaluate(() => window.projectDataSmokeService.currentProjectPath);
  const project = path.join(parent, title);
  assert.equal(fs.existsSync(project), false); fs.mkdirSync(project);
  for (const file of ['package.json', 'package-lock.json', 'node_modules']) {
    if (fs.existsSync(path.join(source, file))) fs.cpSync(path.join(source, file), path.join(project, file), { recursive: true, dereference: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  for (const library of libraries) {
    const info = JSON.parse(fs.readFileSync(path.join(library, 'package.json'), 'utf8'));
    const target = path.join(project, 'node_modules', info.name);
    assert.equal(fs.existsSync(target), false); fs.cpSync(library, target, { recursive: true, dereference: true });
    pkg.dependencies[info.name] = info.version;
  }
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg));
  const board = Object.keys(pkg.dependencies).find(name => name.startsWith('@aily-project/board-')); assert.ok(board);
  fs.copyFileSync(path.join(project, 'node_modules', board, 'template', 'project.abi'), path.join(project, 'project.abi'));
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close()) throw new Error('Close before blank project failed');
    await service.initializeProjectDataSchema(project);
    if (!await service.projectOpen(project)) throw new Error('Blank board project failed to open');
  }, project);
  await waitForBlankProject(page);
  const initial = await page.evaluate(async project => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const workspace = component.blocklyService.workspace;
    if (workspace.getAllVariables().length || workspace.getAllBlocks(false).length !== 3) throw new Error('Board fixture is not empty');
    const saved = await window.projectDataSmokeService.save(project); if (!saved.success) throw new Error(saved.error);
    return workspace.getAllBlocks(false).map(block => ({ id: block.id, type: block.type, deletable: block.isDeletable() }));
  }, project);
  return { project, previousProject, initial };
}

module.exports = { openBlankProject, waitForBlankProject };
