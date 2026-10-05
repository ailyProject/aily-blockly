// Installed only in the disposable regression renderer. No product globals,
// telemetry, field contents or profiler sampling are required.
function installAbsPhaseAudit() {
  const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
  const wrap = (target, method, label) => {
    const original = target?.[method];
    if (typeof original !== 'function') throw new Error(`Missing audit method: ${label}`);
    target[method] = function (...args) {
      const audit = window.auditPhases, start = performance.now();
      const finish = () => {
        if (!audit) return;
        const stats = audit.host[label] ??= { count: 0, ms: 0 };
        stats.count++; stats.ms += performance.now() - start;
      };
      let result;
      try { result = original.apply(this, args); }
      catch (error) { finish(); throw error; }
      if (result && typeof result.then === 'function') return result.finally(finish);
      finish(); return result;
    };
  };
  for (const method of ['prepareProjectCode', 'assertWorkspaceSharedChange', 'getProjectDocument']) {
    wrap(component.blocklyService, method, `editor.${method}`);
  }
  wrap(window.crypto.subtle, 'digest', 'hash.digest');
  const captureDefinitions = component.blocklyService.captureDeclarativeBlockDefinitions;
  component.blocklyService.captureDeclarativeBlockDefinitions = function (...args) {
    const snapshot = captureDefinitions.apply(this, args);
    wrap(snapshot, 'assertCurrent', 'declarations.assertCurrent');
    wrap(snapshot, 'withSynchronousRead', 'declarations.read');
    return snapshot;
  };
  const captureReplay = component.blocklyService.captureNativeReplay;
  component.blocklyService.captureNativeReplay = function (...args) {
    const replay = captureReplay.apply(this, args), audit = window.auditPhases;
    if (audit && !audit.replaySteps) audit.replaySteps = replay.steps.map(step => {
      let label = step.label ?? step.libraryName ?? step.packageName ?? '';
      if (/^[a-z]+:\/\//i.test(label)) { try { label = new URL(label).pathname; } catch { label = ''; } }
      label = label.split(/[?#]/, 1)[0].replace(/\\/g, '/').split('/').slice(-2).join('/').replace(/[^a-zA-Z0-9._@/-]/g, '_').slice(-96);
      return { kind: step.kind, ...(label ? { label } : {}) };
    });
    return replay;
  };
  for (const method of ['prepareSave', 'publishPreparedSaveOutputs']) {
    wrap(component._projectService, method, `project.${method}`);
  }
  wrap(window.Blockly.serialization.workspaces, 'load', 'workspace.load');
  wrap(window.Blockly.serialization.blocks, 'appendInternal', 'workspace.append');
  wrap(window.Blockly.renderManagement, 'triggerQueuedRenders', 'workspace.render');
  const Channel = window.MessageChannel;
  window.MessageChannel = class extends Channel {
    constructor() {
      super();
      const audit = window.auditPhases, start = performance.now();
      let record;
      this.port1.addEventListener('message', event => {
        const reply = event.data;
        if (!audit || !Number.isFinite(reply?.elapsedMs)) return;
        if (!record) audit.native.push(record = { phases: [] });
        const receivedMs = performance.now() - start;
        if (reply.replay) {
          record.replay ??= [];
          if (record.replay.length < 1024) record.replay.push({ ...reply.replay, realmMs: reply.elapsedMs, receivedMs });
          else record.replayDropped = (record.replayDropped ?? 0) + 1;
        } else record.phases.push({ phase: reply.phase ?? (reply.ok ? 'complete' : 'failed'), ms: reply.elapsedMs, receivedMs });
        record.wallMs = performance.now() - start;
      });
      // The product starts the port by assigning onmessage; do not change that lifecycle.
    }
  };
}
module.exports = { installAbsPhaseAudit };
