const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { createLlmRoundDriver } = require('./project-data-llm-round.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');

/** Drive the actual Chat composer. The E2E interface only observes the resulting session. */
async function testLlmGeneration(page, source, root, setPhase) {
  const { project, initial } = await openBlankProject(page, source, root, 'LLM Project');
  const payload = 'Generic Project Data preservation 中文😀\n'.repeat(1600);
  await page.evaluate(async ({ project, payload }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const block = editor.workspace.newBlock('text', 'llm_data_sentinel');
    block.setFieldValue(payload, 'TEXT'); block.initSvg(); block.render(); block.moveBy(500, 50);
    const saved = await window.projectDataSmokeService.save(project);
    if (!saved.success) throw new Error(saved.error);
  }, { project, payload });
  const prompt = `请直接实施并验证当前隔离 Blockly 工程 ${project}：保留现有的三个入口和大文本块（其内容不能修改或删除）。添加普通 int 变量 abs_counter，初值为 7；setup 中将它赋值为 8；loop 中先把它赋值为自身，再延时 1000 毫秒。保持图形和 ABS 可继续编辑，保存后通过主程序正式 project_build 完整编译（不是仅预处理），不上传硬件。请自主查询所需规则/库/宿主能力并完成修改，不要让我手工写代码。仅操作这个隔离工程，不安装或修改库，不访问账号配置，不用外部编译器，不启动子代理；如遇不支持或编译环境错误请停止并如实解释。`;
  const { runRound, request } = await createLlmRoundDriver(page, project, root, setPhase);
  const verify = () => page.evaluate(async ({ initial, payload }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const editor = component.blocklyService, workspace = editor.workspace;
    for (const block of initial) {
      const actual = workspace.getBlockById(block.id);
      if (actual?.type !== block.type || actual.isDeletable() !== block.deletable) throw new Error('Protected root changed');
    }
    if (workspace.getBlockById('llm_data_sentinel')?.getFieldValue('TEXT') !== payload) throw new Error('Large payload changed');
    const model = workspace.getVariable('abs_counter');
    if (!model) throw new Error('Counter model missing');
    const refs = workspace.getAllBlocks(false).filter(block => ['variables_get', 'variables_set'].includes(block.type));
    if (refs.length !== 3 || refs.some(block => block.getFieldValue('VAR') !== model.getId())) throw new Error('Counter references differ');
    const revision = await component._projectService.getAbiRevisionSnapshot();
    if (revision.changed || revision.memoryHash !== revision.diskHash) throw new Error('Memory and persisted ABI differ');
    return { state: editor.getWorkspaceJson(), revision, model: { id: model.getId(), name: model.name } };
  }, { initial, payload });
  const started = Date.now(), rounds = [];
  const first = await runRound(1, prompt); rounds.push(first.evidence);
  const firstSaved = await verify();
  assert.match(first.evidence.code, /abs_counter\s*=\s*8\s*;/);
  fs.writeFileSync(path.join(root, 'llm-variable-round-1.json'), JSON.stringify({ ...first.evidence, saved: firstSaved.revision }, null, 2));
  // Same UI and session; natural-language edit only, no pre-written ABS/tool call plan.
  const second = await runRound(2, `继续当前工程 ${project}：只将 setup 中 abs_counter 的赋值从 8 改为 9。全局初值 7、loop 自身赋值及 1000 毫秒延时、原入口、大文本全部保持。沿用现有变量，保存后再通过主程序 project_build 正式完整编译一次，不上传硬件。仍只操作本隔离工程，不安装或修改库，不读取账号配置；遇不支持或环境错误请停止并说明。`, first.session);
  rounds.push(second.evidence);
  assert.equal(second.session.sessionId, first.session.sessionId);
  setPhase('verify-save-and-reopen');
  const before = await verify();
  assert.deepEqual(before.model, firstSaved.model, 'Second LLM round must reuse the existing variable identity');
  for (const round of rounds) {
    assert.match(round.code, /int\s+abs_counter\s*=\s*7\s*;/);
    assert.match(round.code, /abs_counter\s*=\s*abs_counter\s*;/);
    assert.match(round.code, /delay\s*\(\s*1000\s*\)/);
  }
  assert.match(second.evidence.code, /abs_counter\s*=\s*9\s*;/);
  assert.notEqual(first.evidence.codeHash, second.evidence.codeHash, 'Second build must contain the edited source');
  fs.writeFileSync(path.join(root, 'llm-variable-round-2.json'), JSON.stringify({ ...second.evidence, saved: before.revision }, null, 2));
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'];
  const mirrors = files.map(file => fs.readFileSync(path.join(project, file)));
  assert.ok(!mirrors[0].includes(Buffer.from(payload)), 'ABI must store an external resource reference');
  assert.match(mirrors[1].toString(), /# ABS Schema: 2/);
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Project reopen failed');
  }, project);
  await waitForBlankProject(page); const reopened = await verify();
  assert.deepEqual(reopened.state, before.state); assert.deepEqual(reopened.model, before.model);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(project, file))), mirrors);
  await request({ method: 'session.read', sessionId: second.session.sessionId });
  await page.screenshot({ path: path.join(root, 'llm-reopened-page.png'), fullPage: true });
  return { success: true, project, sessionId: second.session.sessionId, model: second.session.model, rounds,
    durationMs: Date.now() - started, payloadHash: hash(payload),
    variable: before.model, saved: before.revision, reopened: reopened.revision, endpointResponsiveAfterReopen: true };
}

module.exports = { testLlmGeneration };
