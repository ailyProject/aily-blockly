// Opt-in, disposable renderer instrumentation. It observes existing generations;
// never calls the generator again or supplies authority to validate/apply.
function installAbsGenerationAudit() {
  const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
  const Channel = window.MessageChannel;
  window.MessageChannel = class extends Channel {
    constructor() {
      super();
      const audit = window.auditGeneration;
      this.port1.addEventListener('message', event => {
        const evidence = event.data?.ok && event.data.result?.generationEvidence;
        if (audit && evidence) audit.native.push(structuredClone(evidence));
      });
      // Do not start the port; product onmessage assignment owns its lifecycle.
    }
  };
  const prepare = editor.prepareProjectCode;
  editor.prepareProjectCode = function (...args) {
    const audit = window.auditGeneration;
    return prepare.apply(this, args).then(result => {
      if (audit) audit.host.push(result && structuredClone({
        code: result.code, artifacts: result.artifacts, projectMacros: result.projectMacros ?? [],
      }));
      return result;
    });
  };
}

function compareAbsGenerationEvidence(native, host) {
  const { isDeepStrictEqual } = require('node:util');
  const complete = entry => typeof entry?.code === 'string' && (entry.artifacts === null || Array.isArray(entry.artifacts));
  if (!native?.length || host?.length !== 1 || !complete(host[0]) || native.some(value => !complete(value))) {
    return { status: 'unavailable', reason: 'Complete native evidence and exactly one successful host preparation are required.' };
  }
  const fields = ['code', 'artifacts', 'projectMacros'];
  const value = (entry, field) => field === 'projectMacros' ? entry[field] ?? [] : entry[field];
  const mismatches = fields.filter(field => native.some(entry => !isDeepStrictEqual(value(entry, field), value(host[0], field))));
  return { status: mismatches.length ? 'mismatch' : 'matched', mismatches, nativePasses: native.length,
    scope: 'Observed full-load outputs only; not proof of partial-apply equivalence or hidden-state purity.' };
}

module.exports = { installAbsGenerationAudit, compareAbsGenerationEvidence };
