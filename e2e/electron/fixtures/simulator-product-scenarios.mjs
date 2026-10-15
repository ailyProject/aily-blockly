import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectFirmwareReports } from './simulator-evidence.mjs';
import { openSimulatorProject, readSimulatorProjection, verifySimulatorProjectSwitch } from './simulator-product-projects.mjs';

// Optional extension to the existing full-product/Serial harness. No second
// Electron launcher, mocked Agent tools or private native test command path.
export function installSimulatorFixture({ hostRoot, appRoot, index, junction }) {
  const artifact = process.env.SIMULATOR_PRODUCT_ARTIFACT;
  const runtime = process.env.SIMULATOR_PRODUCT_RUNTIME;
  if (!artifact && !runtime) return null;
  assert.ok(artifact && runtime, 'Provide both SIMULATOR_PRODUCT_ARTIFACT and SIMULATOR_PRODUCT_RUNTIME');
  const root = path.resolve(hostRoot, '../aily-subapp/packages/simulator-debugger');
  const bundle = path.join(root, 'dist/simulator-debugger');
  for (const file of [artifact, runtime, path.join(bundle, 'index.js')]) assert.ok(fs.existsSync(file), `Missing ${file}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'package.json')));
  // Freeze the small installed package for this test. Concurrent development
  // rebuilds must not change an in-flight model's tool schema or executable.
  const installed = path.join(appRoot, 'node_modules', manifest.name);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.cpSync(bundle, installed, { recursive: true, errorOnExist: true });
  junction(path.dirname(path.resolve(runtime)), path.join(appRoot, 'node_modules/@aily-project/aily-simulator'));
  index['simulator-debugger'] = { id: 'simulator-debugger', namespace: 'SIMULATOR_DEBUGGER', titleKey: 'simulator-debugger',
    package: manifest.name, version: manifest.version, app: { ...manifest.ailySubapp.app, autoInstall: false } };
  return { manifestPath: path.resolve(artifact), manifest, scenario: JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/s3-adc.json'))) };
}

export async function verifySimulatorProduct({ fixture, projects, agent, model, customModel, workspace, developmentMode,
  until, writeJson, output, application, report, main, chatFrame, command, verifySerial }) {
  const tools = await agent.call({ type: 'tools.list', cwd: workspace });
  assert.ok(JSON.stringify(tools).includes('simulator_debug_run'), 'Actual Chat must discover the installed debugger');
  const full = () => main.frameLocator('.iframe-shell > app-child-tool-native-observer iframe');
  const openFull = async () => {
    const opened = await command('child_app_open', { toolId: 'simulator-debugger', mode: 'embedded' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await until(() => full().locator('#status').getAttribute('data-outcome'), 'installed native observer ready');
  };
  const closeFull = async () => {
    const closed = await command('child_app_control', { toolId: 'simulator-debugger', action: 'close' });
    assert.equal(closed.ok, true, JSON.stringify(closed));
  };
  await openFull();
  assert.equal(await full().locator('#status').getAttribute('data-outcome'), 'idle');
  assert.equal(await full().locator('#firmware').isHidden(), true, 'An idle observer must not invent a firmware identity');
  assert.ok(!fs.readFileSync(path.join(output, 'process.log'), 'utf8').includes('subapp-private-'), 'Opening an observer must not start a Runtime');
  await closeFull();
  const cases = [
    { marker: 'C', scenario: fixture.scenario, outcome: 'passed' },
    { marker: 'D', scenario: { schemaVersion: 1, timeoutMs: 500,
      steps: [{ id: 'run', op: 'resume' }, { id: 'negative', op: 'uart.expect', contains: 'NEVER_EMITTED_BY_THIS_FIRMWARE' }] }, outcome: 'failed' },
    { marker: 'E', scenario: { schemaVersion: 1, timeoutMs: 120000,
      steps: [{ id: 'run', op: 'resume' }, { id: 'pending', op: 'uart.expect', contains: 'NEVER_EMITTED_BY_THIS_FIRMWARE' }] }, outcome: 'cancelled' },
  ];
  const evidence = { mode: developmentMode, model: 'deterministic-local-transport-not-autonomous-LLM', cases: [] };
  let savedReport;
  for (const item of cases) {
    if (projects && item.marker === 'E') {
      await openSimulatorProject({ project: projects[0], command, until, writeJson, output, label: 'initial' });
      const skip = main.getByText('跳过', { exact: true });
      if (await skip.isVisible()) await skip.click();
    }
    model.planTools(item.marker, [
      { name: 'tool_load', arguments: { names: ['simulator_debug_run'] } },
      { name: 'tool_invoke', arguments: { name: 'simulator_debug_run', arguments: { manifestPath: fixture.manifestPath, scenario: item.scenario } } },
    ]);
    const sessionWorkspace = projects && item.marker === 'E' ? projects[0].path : workspace;
    const { snapshot } = await agent.call({ type: 'session.create', options: { cwd: sessionWorkspace, developmentMode,
      model: { provider: customModel.provider, id: customModel.id }, permissionMode: 'full' } });
    try {
      const name = `Simulator session ${item.marker}`;
      await agent.call({ type: 'setName', sessionId: snapshot.sessionId, name });
      // Use the real Chat selection UI; no private component state injection.
      for (const button of await main.locator('.subapp-dock button[title="Collapse"]').all()) await button.click();
      await chatFrame.goto(chatFrame.url());
      await chatFrame.getByText(name, { exact: true }).filter({ visible: true }).first().click();
      await agent.call({ type: 'prompt', sessionId: snapshot.sessionId, idempotencyKey: `simulator-${item.marker}`,
        text: `PRODUCT-FIXTURE:${item.marker} Run the firmware test through the available tools.`, mode: 'agent' });
      const compact = main.frameLocator('.subapp-dock app-child-tool-native-observer iframe');
      await until(async () => {
        const outcome = await compact.locator('#status').getAttribute('data-outcome', { timeout: 1000 }).catch(() => null);
        return outcome === 'running';
      }, 'live native Dock');
      assert.equal(await compact.locator('#stop').isEnabled(), true);
      if (item.marker === 'C') {
        await openFull(); await closeFull(); // A live observer close cannot stop the firmware batch.
      }
      if (item.outcome === 'cancelled') {
        await until(() => compact.locator('#phase').textContent().then(text => /执行场景|Running scenario/.test(text)), 'running engine before UI stop');
        if (projects) await verifySimulatorProjectSwitch({ projects, main, sessionId: snapshot.sessionId, command, until, writeJson, output, report });
        assert.match(await compact.locator('#firmware-target').innerText(), /esp32s3/);
        await compact.locator('#stop').click();
      }
      const completed = await until(async () => {
        const current = await agent.call({ type: 'session.snapshot', sessionId: snapshot.sessionId });
        return current.isIdle && JSON.stringify(current.messages).includes(`PRODUCT-FIXTURE:${item.marker} complete`) && current;
      }, `Chat firmware batch ${item.marker}`, 90000);
      writeJson(path.join(output, `chat-simulator-${item.marker}.json`), completed);
      if (item.marker === 'C') savedReport = collectFirmwareReports(completed.messages)[0];
      const toolResult = model.requests.filter(request => request.marker === item.marker && !request.auxiliary).at(-1)?.lastToolResult;
      if (item.outcome === 'cancelled') {
        assert.ok(toolResult?.includes('SUBAPP_RPC_CANCELLED'), String(toolResult));
      } else {
        assert.ok(toolResult?.includes(`"outcome":"${item.outcome}"`) || toolResult?.includes(`"outcome": "${item.outcome}"`), String(toolResult));
        assert.ok(toolResult.includes('supplied-firmware-snapshot'));
      }
      await until(() => compact.locator('#status').getAttribute('data-outcome').then(value => value === item.outcome), 'Dock terminal state');
      if (projects && item.marker === 'E') {
        const terminal = await readSimulatorProjection(main, snapshot.sessionId);
        assert.equal(terminal.snapshot.cleanup?.closed, true);
        assert.ok(terminal.snapshot.cleanup?.resources);
        assert.ok(Object.values(terminal.snapshot.cleanup.resources).every(value => value === 0));
        const directory = path.resolve(terminal.snapshot.evidenceDirectory);
        assert.ok(directory.startsWith(path.resolve(output) + path.sep));
        const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'report.json')));
        assert.equal(persisted.artifactId, savedReport.artifactId);
        assert.equal(persisted.manifestSha256, savedReport.manifestSha256);
        assert.deepEqual(persisted.snapshot, savedReport.snapshot, 'Editor selection must not replace the selected S3 firmware');
        assert.equal(persisted.currentProjectAcceptance, false, 'An S3 batch cannot certify the newly selected UNO project');
        writeJson(path.join(output, 'project-switch-terminal.json'), terminal);
        report.checks.push('ui-stop-after-project-switch-releases-engine-resources');
      }
      await main.screenshot({ path: path.join(output, `simulator-dock-${item.marker}.png`) });
      await openFull();
      assert.equal(await full().locator('#status').getAttribute('data-outcome'), item.outcome);
      await main.screenshot({ path: path.join(output, `simulator-${item.marker}.png`) });
      await closeFull(); await openFull();
      assert.equal(await full().locator('#status').getAttribute('data-outcome'), item.outcome, 'Reopen retains the terminal batch');
      await closeFull();
      await verifySerial(); // Running a QEMU batch must not steal physical UART owners.
      evidence.cases.push({ marker: item.marker, outcome: item.outcome, toolCalls: 2 });
    } finally { await agent.call({ type: 'session.close', sessionId: snapshot.sessionId }); }
  }
  assert.ok(savedReport?.evidence.runId, 'Completed runs expose an opaque evidence handle');
  const beforeReads = fs.readFileSync(path.join(output, 'process.log'), 'utf8').match(/subapp-private-/g)?.length || 0;
  model.planTools('F', [
    { name: 'tool_load', arguments: { names: ['simulator_debug_evidence'] } },
    { name: 'tool_invoke', arguments: { name: 'simulator_debug_evidence', arguments: { runId: savedReport.evidence.runId, limitBytes: 128 } } },
  ]);
  const { snapshot: reader } = await agent.call({ type: 'session.create', options: { cwd: workspace, developmentMode,
    model: { provider: customModel.provider, id: customModel.id }, permissionMode: 'full' } });
  try {
    await agent.call({ type: 'prompt', sessionId: reader.sessionId, idempotencyKey: 'simulator-evidence-F',
      text: 'PRODUCT-FIXTURE:F Read the saved firmware report without rerunning it.', mode: 'agent' });
    const completed = await until(async () => {
      const current = await agent.call({ type: 'session.snapshot', sessionId: reader.sessionId });
      return current.isIdle && JSON.stringify(current.messages).includes('PRODUCT-FIXTURE:F complete') && current;
    }, 'Chat saved evidence read', 30000);
    writeJson(path.join(output, 'chat-simulator-evidence.json'), completed);
    const result = model.requests.filter(request => request.marker === 'F' && !request.auxiliary).at(-1)?.lastToolResult;
    assert.ok(result?.includes(savedReport.evidence.runId), String(result));
    assert.match(result, /"nextOffsetBytes"\s*:\s*128/);
    assert.match(result, /aily-firmware-debug-report/);
    const afterReads = fs.readFileSync(path.join(output, 'process.log'), 'utf8').match(/subapp-private-/g)?.length || 0;
    assert.equal(afterReads, beforeReads, 'Reading history must not launch another native Runtime');
    report.checks.push('actual-chat-reads-prior-session-evidence-without-runtime');
  } finally { await agent.call({ type: 'session.close', sessionId: reader.sessionId }); }
  writeJson(path.join(output, 'simulator-product.json'), evidence);
  report.checks.push('actual-chat-debugger-tool-load-invoke-positive-negative', 'debugger-observer-entry-dock-reopen-and-ui-stop',
    'debugger-batches-preserve-two-serial-owners');
}
