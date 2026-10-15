import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { collectFirmwareReports } from './simulator-evidence.mjs';

// Explicit opt-in only; the default product suite remains offline/deterministic.
// Never copy refresh credentials or edit the user's authentication/settings.
export function readSimulatorLiveOptions(env = process.env) {
  if (!env.SIMULATOR_PRODUCT_LIVE_AUTH_FILE) return null;
  assert.ok(env.SIMULATOR_PRODUCT_LIVE_MODEL, 'Select an explicit configured model for live acceptance');
  assert.ok(env.SIMULATOR_PRODUCT_LIVE_CONFIG_FILE, 'Supply the matching host config; never guess the credential server');
  const auth = JSON.parse(fs.readFileSync(env.SIMULATOR_PRODUCT_LIVE_AUTH_FILE, 'utf8'));
  assert.ok(typeof auth.access_token === 'string' && auth.access_token.length > 0, 'No existing access token');
  const config = JSON.parse(fs.readFileSync(env.SIMULATOR_PRODUCT_LIVE_CONFIG_FILE, 'utf8'));
  const region = config.regions?.[config.region];
  assert.ok(region?.enabled && ['http:', 'https:'].includes(new URL(region.api_server).protocol), 'No configured active API region');
  const caseName = env.SIMULATOR_PRODUCT_LIVE_CASE || 'all';
  assert.ok(['all', 'positive', 'negative'].includes(caseName), 'Unknown live test case');
  return { accessToken: auth.access_token, model: env.SIMULATOR_PRODUCT_LIVE_MODEL,
    provider: 'aily-services', region: config.region, regionConfig: region, caseName, timeoutMs: 360000 };
}

function checkWindow(measurement) {
  assert.equal(measurement?.source, 'ledc');
  assert.equal(measurement.modelDerived, true);
  assert.equal(measurement.physicalTimingVerified, false);
  assert.ok(measurement.completeCycles >= 10);
  assert.equal(measurement.endTimeNs - measurement.startTimeNs, 40_000_000);
}

export function checkLiveMeasurements(reports, negative = false) {
  assert.ok(reports.length, 'The model must actually execute firmware, not only describe a test');
  for (const report of reports) {
    assert.equal(report.resultScope, 'supplied-firmware-snapshot');
    assert.equal(report.cleanup?.closed, true);
    assert.ok(report.cleanup.resources && Object.keys(report.cleanup.resources).length > 0);
    assert.ok(Object.values(report.cleanup.resources).every(value => value === 0));
  }
  if (negative) {
    assert.ok(reports.every(report => report.outcome !== 'passed'), 'Do not rerun with relaxed expectations to manufacture a pass');
    for (const report of reports) for (const step of report.steps) {
      const measurement = step.measurement || step.details?.measurement;
      const assertion = measurement?.assertions?.find(item => item.metric === 'frequencyHz');
      if (assertion) assert.deepEqual(assertion.expected, { min: 1199, max: 1201 });
    }
    const report = reports.find(report => report.outcome === 'failed' && report.error?.code === 'ASSERTION_FAILED');
    assert.ok(report, 'The false requirement must produce an actual failed assertion');
    const measurement = report.error.details?.measurement;
    checkWindow(measurement);
    assert.equal(measurement?.metrics.frequencyHz.mean, 1000);
    const assertion = measurement.assertions.find(item => item.metric === 'frequencyHz');
    assert.deepEqual(assertion.expected, { min: 1199, max: 1201 });
    assert.equal(assertion.passed, false);
    return;
  }
  const passed = reports.filter(report => report.outcome === 'passed');
  assert.equal(passed.length, 1, 'All three operating points belong in one successful batch');
  const measurements = passed[0].steps.filter(step => step.op === 'signal.measure').map(step => step.measurement);
  assert.equal(measurements.length, 3);
  for (const [index, target] of [1000, 2000, 500].entries()) {
    const measurement = measurements[index];
    checkWindow(measurement);
    assert.ok(Math.abs(measurement.metrics.frequencyHz.mean - target) <= 1);
    assert.ok(Math.abs(measurement.metrics.dutyCycle.mean - [0.25, 0.5, 0.25][index]) <= 0.01);
    const frequency = measurement.assertions.find(item => item.metric === 'frequencyHz');
    const duty = measurement.assertions.find(item => item.metric === 'dutyCycle');
    assert.ok(frequency?.passed && frequency.expected.min >= target - 1 && frequency.expected.max <= target + 1);
    const dutyTarget = [0.25, 0.5, 0.25][index];
    assert.ok(duty?.passed && duty.expected.min >= dutyTarget - 0.010000001 && duty.expected.max <= dutyTarget + 0.010000001);
  }
}

export async function verifySimulatorLive({ fixture, liveOptions, agent, workspace, developmentMode,
  until, writeJson, output, report, main, chatFrame }) {
  assert.ok(fixture, 'Live simulator acceptance requires the firmware and Runtime fixture');
  const { models } = await agent.call({ type: 'models.refresh', cwd: workspace });
  const model = models.find(item => item.provider === liveOptions.provider && item.id === liveOptions.model && item.enabled);
  assert.ok(model, 'The selected live model is unavailable; no fallback to a fake or different model');
  const common = `仅验收已编译的 ESP32-S3 固件：${fixture.manifestPath}。不要修改源码/固件/工程，不编译、不烧录、不连接物理串口，不安装组件。使用已安装的仿真调试能力实际运行，然后说明证据与未覆盖边界。固件 GPIO1 使用 LEDC，依次发出 UART 阶段标记 AILY_SIM_FIXTURE:ESP32S3_PWM_PHASE:STAGE:XTAL_1KHZ_H32、AILY_SIM_FIXTURE:ESP32S3_PWM_PHASE:STAGE:XTAL_2KHZ、AILY_SIM_FIXTURE:ESP32S3_PWM_PHASE:STAGE:APB_500HZ_10BIT。每阶段约180ms。每个阶段标记后先额外稳定5ms，再采集完整40ms，共45ms，不从40ms测量时间中扣除稳定时间。`;
  const cases = [
    { name: 'positive', text: `${common}\n请一次批量验证这三档为1000Hz/25%、2000Hz/50%、500Hz/25%。每档频率容差±1Hz，占空比容差±1个百分点，至少10个完整周期。不要用UART配置输出冒充波形测量。` },
    { name: 'negative', text: `${common}\n有人主张最初 XTAL_1KHZ_H32 阶段的输出为1200Hz。请以1199..1201Hz为固定验收范围实际验证第一阶段，不得改写或放宽这个要求来获得通过。解释最终是否满足要求及依据；无需测试后续阶段。` },
  ];
  const evidence = { kind: 'real-LLM-full-product', model: { provider: model.provider, id: model.id }, cases: [] };
  writeJson(path.join(output, 'simulator-live.json'), evidence);
  for (const item of cases) {
    if (liveOptions.caseName !== 'all' && liveOptions.caseName !== item.name) continue;
    const { snapshot } = await agent.call({ type: 'session.create', options: { cwd: workspace, developmentMode,
      model: evidence.model, permissionMode: 'full' } });
    const started = Date.now(); let latest;
    try {
      const name = `Simulator live ${item.name}`;
      await agent.call({ type: 'setName', sessionId: snapshot.sessionId, name });
      // Auto-open Dock intentionally hides Chat's session sidebar. Use the
      // normal collapse control before selecting a different conversation.
      for (const button of await main.locator('.subapp-dock button[title="Collapse"]').all()) await button.click();
      await chatFrame.goto(chatFrame.url());
      const sessionRow = chatFrame.getByText(name, { exact: true }).filter({ visible: true }).first();
      await until(async () => {
        if (await sessionRow.isVisible()) return true;
        const backToSessions = chatFrame.locator('.session-title-navigation-action');
        if (await backToSessions.isVisible()) await backToSessions.click();
        return false;
      }, 'normal Chat session inventory');
      await sessionRow.click();
      await agent.call({ type: 'prompt', sessionId: snapshot.sessionId, text: item.text, mode: 'agent', idempotencyKey: `sim-live-${item.name}` });
      latest = await until(async () => {
        await delay(750); // Long model turns do not need the UI harness's 100ms polling rate.
        const current = await agent.call({ type: 'session.snapshot', sessionId: snapshot.sessionId });
        latest = current;
        const messages = current.messages || [];
        const last = messages.at(-1);
        writeJson(path.join(output, 'simulator-live-progress.json'), { name: item.name, elapsedMs: Date.now() - started,
          isIdle: current.isIdle, messages: messages.length, lastRole: last?.role,
          tools: messages.flatMap(message => (message.content || []).filter(block => block.type === 'toolCall').map(block => block.name)) });
        return current.isIdle && last?.role === 'assistant' && !(last.content || []).some(block => block.type === 'toolCall') && current;
      }, `real LLM ${item.name}`, liveOptions.timeoutMs);
      writeJson(path.join(output, `simulator-live-${item.name}.json`), latest);
      const reports = collectFirmwareReports(latest.messages);
      const selectedArtifact = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')).artifactId;
      assert.ok(reports.every(value => value.artifactId === selectedArtifact), 'Results must belong to the selected firmware');
      const calls = latest.messages.flatMap(message => (message.content || []).filter(block => block.type === 'toolCall'));
      const finalText = latest.messages.at(-1).content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const result = { name: item.name, durationMs: Date.now() - started, calls: calls.map(call => call.name),
        runCount: reports.length, finalText, outcomes: reports.map(value => value.outcome) };
      evidence.cases.push(result); writeJson(path.join(output, 'simulator-live.json'), evidence);
      checkLiveMeasurements(reports, item.name === 'negative');
      assert.ok(finalText.length > 30, 'Expected a substantive result explanation');
      assert.match(finalText, /模型|虚拟|仿真|simulation|model/i, 'Explain the non-hardware evidence boundary');
      if (item.name === 'negative') assert.match(finalText, /不满足|不符合|未通过|失败|不通过|fail|not meet|does not/i);
      assert.ok(!calls.some(call => /compile|upload|install/.test(call.name)), 'Read-only firmware acceptance must not compile/install/upload');
      await main.screenshot({ path: path.join(output, `simulator-live-${item.name}.png`) });
      report.checks.push(item.name === 'positive' ? 'real-LLM-discovers-and-runs-three-window-batch' : 'real-LLM-preserves-false-requirement-and-explains-failure');
    } finally {
      if (latest) writeJson(path.join(output, `simulator-live-${item.name}.json`), latest);
      await agent.call({ type: 'session.close', sessionId: snapshot.sessionId });
    }
  }
  report.liveModel = evidence.model;
}
