const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { createLlmRoundDriver } = require('./project-data-llm-round.cjs');

/** Natural-language UI requests, never pre-written ABS or injected tool calls. */
async function testLlmNativeCreation(page, source, root, setPhase) {
  const library = process.env.AILY_ABS_MAX31865_LIBRARY;
  assert.ok(library && path.isAbsolute(library));
  const { project, initial } = await openBlankProject(page, source, root, 'LLM Native Project', [library]);
  const payload = 'Native ABS external data preservation 中文😀\n'.repeat(1600);
  await page.evaluate(async ({ project, payload }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const block = editor.workspace.newBlock('text', 'native_data_sentinel');
    block.setFieldValue(payload, 'TEXT'); block.initSvg(); block.render(); block.moveBy(500, 50);
    const saved = await window.projectDataSmokeService.save(project); if (!saved.success) throw new Error(saved.error);
  }, { project, payload });
  const { runRound, request } = await createLlmRoundDriver(page, project, root, setPhase);
  const boundary = '保持现有三个入口、大文本块及内容不变。保持图形和 ABS 可继续编辑。仅操作本隔离工程，不安装或修改库、不读取账号配置、不使用外部编译器、不启动子代理、不上传硬件。请自主查询现有规则、宿主能力和已安装库；必要时依据库实现提供显式模型创建意图。遇不支持或环境错误请停止并如实解释，不绕过校验。';
  const first = await runRound(1, `请直接实施当前隔离 Blockly 工程 ${project}：在 setup 中添加 MAX31865 初始化，对象名 native_rtd，硬件 SPI，CS 引脚 D1，2 线制。保存后通过主程序 project_build 正式完整编译，不是仅生成/预处理 C++。${boundary}`);
  const inspect = software => page.evaluate(async ({ software, initial, payload }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const editor = component.blocklyService, workspace = editor.workspace;
    for (const root of initial) if (workspace.getBlockById(root.id)?.isDeletable() !== root.deletable) throw new Error('Protected root changed');
    if (workspace.getBlockById('native_data_sentinel')?.getFieldValue('TEXT') !== payload) throw new Error('External payload changed');
    const blocks = workspace.getBlocksByType('max31865_init', false);
    if (blocks.length !== 1 || blocks[0].getFieldValue('VAR') !== 'native_rtd') throw new Error('Expected one native sensor');
    const block = blocks[0];
    if (block.getFieldValue('SPI_MODE') !== (software ? 'SW' : 'HW') || block.getFieldValue('CS_PIN') !== 'D1'
      || block.getFieldValue('WIRES') !== 'MAX31865_2WIRE') throw new Error('Native configuration changed');
    if (software && ['SW_SCK_PIN', 'SW_MOSI_PIN', 'SW_MISO_PIN'].some((name, i) => block.getFieldValue(name) !== ['D2', 'D3', 'D4'][i])) throw new Error('Dynamic pins lost');
    const model = workspace.getVariable('native_rtd', 'Adafruit_MAX31865');
    if (!model) throw new Error('Explicit typed model missing');
    const revision = await component._projectService.getAbiRevisionSnapshot();
    if (revision.changed || revision.memoryHash !== revision.diskHash) throw new Error('Memory/disk ABI differ');
    return { state: editor.getWorkspaceJson(), id: block.id, model: { id: model.getId(), name: model.name, type: model.type }, revision };
  }, { software, initial, payload });
  const hardware = await inspect(false);
  const second = await runRound(2, `继续当前工程 ${project}：将刚才同一个 native_rtd 初始化块改成软件 SPI，SCK=D2、MOSI=D3、MISO=D4，CS=D1 和 2 线制保持。保留既有对象及块身份，不额外创建重复对象。保存后再通过主程序 project_build 正式完整编译一次。${boundary}`, first.session);
  const software = await inspect(true);
  assert.equal(software.id, hardware.id); assert.deepEqual(software.model, hardware.model);
  assert.notEqual(first.evidence.codeHash, second.evidence.codeHash);
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'], mirrors = files.map(file => fs.readFileSync(path.join(project, file)));
  assert.ok(!mirrors[0].includes(Buffer.from(payload))); assert.ok(!mirrors[1].includes(Buffer.from(payload)));
  setPhase('native-llm-save-and-reopen');
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Native LLM project reopen failed');
  }, project);
  await waitForBlankProject(page); const reopened = await inspect(true);
  assert.deepEqual(reopened.state, software.state); assert.equal(reopened.id, software.id); assert.deepEqual(reopened.model, software.model);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(project, file)), mirrors[i]));
  await request({ method: 'session.read', sessionId: second.session.sessionId });
  await page.screenshot({ path: path.join(root, 'llm-native-reopened.png'), fullPage: true });
  return { success: true, project, sessionId: second.session.sessionId, model: second.session.model,
    rounds: [first.evidence, second.evidence], blockId: software.id, variable: software.model,
    payloadHash: createHash('sha256').update(payload).digest('hex'), reopened: true, saved: software.revision };
}
module.exports = { testLlmNativeCreation };
