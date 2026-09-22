const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');
const { waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');

async function testDataAbsContext(page, seed, root) {
  const document = JSON.parse(fs.readFileSync(path.join(seed, 'project.abi'), 'utf8'));
  document.blocks.blocks.find(block => block.id === 'project_data_smoke_text').fields.TEXT = 'large context 数据😀'.repeat(5000);
  fs.writeFileSync(path.join(seed, 'project.abi'), JSON.stringify(document));
  const project = path.join(root, 'Context Data');
  await page.evaluate(async ({ seed, project }) => {
    const service = window.projectDataSmokeService;
    if (!await service.close()) throw new Error('Close before context test failed');
    await service.importProjectDirectory(seed, project);
    await service.initializeProjectDataSchema(project);
    if (!await service.projectOpen(project)) throw new Error('Data context project failed to open');
  }, { seed, project });
  await waitForBlankProject(page);
  const exported = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'context');
  assert.equal(exported.ok, true);
  const context = await testSelectedAbsContext(page, project);
  const large = await page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const block = editor.workspace.getBlockById('project_data_smoke_text');
    return { length: block.getFieldValue('TEXT').length, context: editor.getBlockContext(block.id) };
  });
  assert.ok(large.length > 50000 && large.context.absSnippet.length <= 2000);
  assert.ok(large.context.absSnippet.includes('$ailyProjectDataValue'));
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Data context reopen failed');
  }, project);
  await waitForBlankProject(page);
  const reopened = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
    .blocklyService.getBlockContext('project_data_smoke_text'));
  assert.equal(reopened.absLineRange, '无'); assert.equal(reopened.absGeneration, undefined);
  return { success: true, project, context, largeTextLength: large.length, reopenInvalidated: true };
}

async function testSelectedAbsContext(page, project) {
  const abs = fs.readFileSync(path.join(project, 'project.abs'), 'utf8');
  const map = JSON.parse(fs.readFileSync(path.join(project, 'project.abs.map.json'), 'utf8'));
  const contexts = await page.evaluate(ids => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    return ids.map(id => editor.getBlockContext(id));
  }, map.nodes.map(node => node.blockId));
  contexts.forEach((context, index) => {
    const node = map.nodes[index], text = abs.slice(node.start, node.end).trimEnd();
    const start = abs.slice(0, node.start).split('\n').length, end = start + text.split('\n').length - 1;
    assert.equal(context.absGeneration, map.generation);
    assert.equal(context.absLineRange, start === end ? `${start}` : `${start}-${end}`);
    if (text.length < 2000 && text.split('\n').length <= 6) assert.equal(context.absSnippet, text);
    assert.ok(context.absSnippet.length <= 2000);
    assert.ok(context.formatted.includes(map.generation));
  });
  return { success: true, generation: map.generation, comparedBlocks: contexts.length };
}

/** Disconnect the real embedded UI during its five concurrent read-only catalog
 * requests. No backend replacement, prompt or mutation; reconnect must recover. */
async function testLinkedChatDisconnect(page) {
  await page.addInitScript(() => {
    if (window.parent === window) return;
    const NativeWebSocket = window.WebSocket;
    const types = new Set(['models.list', 'model.preference.get', 'tools.list', 'memory.snapshot', 'settings.snapshot']);
    const held = new Set(), pending = new Set();
    const evidence = window.__catalogDisconnectSmoke = { injected: false, opened: 0, held: [], responses: 0 };
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('open', () => evidence.opened++);
        this.addEventListener('message', event => {
          let value; try { value = JSON.parse(event.data); } catch { return; }
          if (value.type === 'response' && pending.delete(value.id) && value.ok) evidence.responses++;
        });
      }
      send(data) {
        let value; try { value = JSON.parse(data); } catch { return super.send(data); }
        if (types.has(value.command?.type)) {
          if (!evidence.injected) {
            held.add(value.command.type); evidence.held = [...held];
            if (held.size === types.size) {
              evidence.injected = true;
              setTimeout(() => this.close(4001, 'isolated catalog disconnect test'), 0);
            }
            return;
          }
          pending.add(value.id);
        }
        return super.send(data);
      }
    };
  });
  const iframe = page.locator('app-main-window nz-sider app-child-tool-host iframe');
  const original = await (await iframe.elementHandle()).contentFrame();
  await original.evaluate(() => location.reload());
  let result;
  for (let attempt = 0; attempt < 180; attempt++) {
    const frame = await (await iframe.elementHandle()).contentFrame();
    result = await frame.evaluate(() => window.__catalogDisconnectSmoke).catch(() => undefined);
    if (result?.injected && result.opened >= 2 && result.responses >= 5) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(result?.injected, true, 'Concurrent catalog reads were not observed');
  assert.ok(result.opened >= 2 && result.responses >= 5, 'Embedded transport did not reconnect and refresh the catalog');
  return { success: true, ...result };
}

module.exports = { testSelectedAbsContext, testLinkedChatDisconnect, testDataAbsContext };
