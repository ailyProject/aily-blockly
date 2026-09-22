const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { createLlmRoundDriver } = require('./project-data-llm-round.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const resourceHashes = directory => fs.readdirSync(directory, { recursive: true })
  .filter(file => fs.statSync(path.join(directory, file)).isFile()).sort().map(file => {
    const bytes = fs.readFileSync(path.join(directory, file));
    return { file, bytes: bytes.length, hash: hash(bytes) };
  });

// This fixture names one real library. Preservation assertions cover the entire serialized
// workspace and every asset byte; production Project Data adaptation remains field/library agnostic.
async function testLlmAssets(page, source, root, setPhase) {
  const project = path.join(root, 'LLM Animation');
  setPhase('llm-assets-import');
  await page.evaluate(async ({ archive, project }) => {
    const service = window.projectDataSmokeService;
    if (!await service.close()) throw new Error('Close before data fixture failed');
    service.importProjectDirectory(archive, project, true);
    await service.initializeProjectDataSchema(project);
    if (!await service.projectOpen(project)) throw new Error('Data fixture failed to open');
  }, { archive: path.dirname(source), project });
  await waitForBlankProject(page);
  const capture = () => page.evaluate(async project => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const editor = component.blocklyService;
    const revision = await component._projectService.getAbiRevisionSnapshot();
    if (revision.changed || revision.memoryHash !== revision.diskHash) throw new Error('Data workspace differs from disk');
    const players = editor.workspace.getAllBlocks(false).filter(block => block.type === 'seeed_gfx_play_animation');
    if (players.length !== 1) throw new Error('Expected the actual installed animation example');
    const target = players[0].getInputTargetBlock('X');
    if (target?.type !== 'math_number') throw new Error('Example X coordinate is not a number block');
    return { state: editor.getWorkspaceJson(), revision, targetId: target.id, x: target.getFieldValue('NUM'),
      code: editor.getGeneratedCode() };
  }, project);
  await page.evaluate(async project => {
    const result = await window.projectDataSmokeService.save(project);
    if (!result.success) throw new Error(result.error);
  }, project);
  const initial = await capture(); assert.equal(initial.x, 60);
  const assets = resourceHashes(path.join(project, 'assets'));
  assert.ok(assets.some(file => file.bytes >= 374400), 'Actual frame data must be in the fixture');
  const headers = [...initial.code.matchAll(/#include\s+"((?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h)"/g)]
    .map(match => { const file = match[1], bytes = fs.readFileSync(path.join(project, 'src', file));
      return { file, bytes: bytes.length, hash: hash(bytes) }; });
  assert.ok(headers.some(header => header.bytes > 65536), 'Real animation must produce an external C++ header');
  const expectedState = x => {
    const state = structuredClone(initial.state);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.id === initial.targetId && value.type === 'math_number') value.fields.NUM = x;
      for (const child of Object.values(value)) visit(child);
    };
    visit(state); return state;
  };
  const verify = async (x, compiled) => {
    const current = await capture(); assert.equal(current.x, x); assert.equal(current.targetId, initial.targetId);
    assert.deepEqual(current.state, expectedState(x), 'Only the requested coordinate may change; all IDs, models and payloads must survive');
    assert.deepEqual(resourceHashes(path.join(project, 'assets')), assets);
    for (const header of headers) {
      assert.equal(hash(fs.readFileSync(path.join(project, 'src', header.file))), header.hash);
      if (compiled) assert.equal(hash(fs.readFileSync(path.join(project, '.temp/sketch', header.file))), header.hash,
        'The compiler must consume the same generated header as project/src');
    }
    return current.revision;
  };
  const { runRound, request } = await createLlmRoundDriver(page, project, root, setPhase);
  const rounds = []; let previous;
  for (const [number, x] of [[1, 61], [2, 62]]) {
    const prompt = `请${number === 2 ? '继续当前会话，' : ''}直接编辑当前隔离 Blockly 工程 ${project}：只把现有播放动画的 X 坐标从 ${x - 1} 改为 ${x}。Y 坐标、动画帧内容及播放配置、初始化、入口、变量和其他块全部保持；不要重新导入动画或生成图片。请自主查询规则和宿主能力，通过 ABS 完成修改并保存，随后使用主程序 project_build 正式完整编译（不是仅预处理），不要上传硬件。只操作本隔离工程，不安装/修改库，不读取账号配置，不用外部编译器或子代理；遇不支持或编译环境错误就停止并如实说明。`;
    const result = await runRound(number, prompt, previous);
    assert.match(result.evidence.code, new RegExp(`seeedGfxDrawAnimationFrame\\(tft,\\s*${x},\\s*60,`),
      'Compiled animation call must use the requested X and unchanged Y');
    for (const header of headers) assert.ok(result.evidence.code.includes(`#include "${header.file}"`),
      'The compiled sketch must retain the generated data include');
    rounds.push({ ...result.evidence, saved: await verify(x, true) }); previous = result.session;
    fs.writeFileSync(path.join(root, `llm-assets-round-${number}.json`), JSON.stringify(rounds.at(-1), null, 2));
  }
  assert.notEqual(rounds[0].codeHash, rounds[1].codeHash);
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'];
  const mirrors = files.map(file => fs.readFileSync(path.join(project, file)));
  setPhase('llm-assets-save-and-reopen');
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Data project reopen failed');
  }, project);
  await waitForBlankProject(page);
  const reopened = await verify(62, false);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(project, file))), mirrors);
  await request({ method: 'session.read', sessionId: previous.sessionId });
  await page.screenshot({ path: path.join(root, 'llm-assets-reopened-page.png'), fullPage: true });
  return { success: true, project, sessionId: previous.sessionId, model: previous.model, rounds, assets, headers, reopened };
}

module.exports = { testLlmAssets };
