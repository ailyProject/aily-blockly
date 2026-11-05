import '@angular/compiler';
import { evaluateNativeCandidate } from '../../../src/app/editors/blockly-editor/services/blockly-native-candidate';
import { processI18n, processJsonVar } from '../../../src/app/editors/blockly-editor/components/blockly/abf';
import { createAbsReadbackVerifier } from '../../../src/app/integrations/blockly/abs/abs-readback';
import { indexAbsAbi } from '../../../src/app/integrations/blockly/abs/abs-abi-index';
import { readAbsSyntax } from '../../../src/app/integrations/blockly/abs/abs-syntax';
import { walkAbsRawSyntax } from '../../../src/app/integrations/blockly/abs/abs-syntax-binding';
import { customFunctionSyntax } from '../../../src/app/integrations/blockly/abs/abs-custom-function-syntax';
import { parseBlockDefinition } from '../../../src/app/integrations/blockly/abs/block-definition.model';
import { captureAbsCustomFunctions } from '../../../src/app/integrations/blockly/abs/abs-custom-functions';
import { captureAbsDeclarativeContracts } from '../../../src/app/integrations/blockly/abs/abs-declarative-contracts';
import { createAbsProjection } from '../../../src/app/integrations/blockly/abs/abs-identity-map';
import { createAbsReconciler } from '../../../src/app/integrations/blockly/abs/abs-reconciler';
import { prepareAbsNativeReconciliation } from '../../../src/app/integrations/blockly/abs/abs-native-reconciliation';
import { projectDataRuntime } from '../../../src/app/services/domains/project/project-data/project-data-runtime';
import { captureAbsVariableDeclarations } from '../../../src/app/integrations/blockly/abs/abs-declaration-intents';

Object.assign(window, { NativeParamsRepro: {
  async runReconciled(source: string, steps: any[], variables: any[]) {
    // These graphs have no external resources. Keep the actual resource barrier;
    // fail closed if this supposedly local fixture ever tries filesystem access.
    (window as any).fs = new Proxy({}, { get() { throw Error('The synthetic fixture attempted resource I/O'); } });
    (window as any).path = { resolve: value => value, join: (...parts) => parts.join('/') };
    projectDataRuntime.configure('/own-synthetic-params-repro');
    const json = new Map(steps.flatMap(step => step.definitions ?? []).map(value => [value.type, value]));
    const kinds: any = { custom_function_def: 'definition', custom_function_call_return_advance: 'value-call', custom_function_call_advance: 'statement-call' };
    const snapshot: any = { types: [...json.keys()], registered: type => json.has(type) || !!kinds[type], assertCurrent() {}, get: type => json.get(type),
      customFunctions: { get: type => kinds[type] && { kind: kinds[type], parameterTypes: ['int', 'String', 'void', 'bool', 'float'] } } };
    const custom = captureAbsCustomFunctions(snapshot), shapes = captureAbsDeclarativeContracts(snapshot);
    const workspace: any = { blocks: { blocks: [] } }, stages: any[] = [], traces: any[] = [], Channel = window.MessageChannel;
    window.MessageChannel = function() {
      const channel = new Channel();
      channel.port1.addEventListener('message', event => { if (event.data?.reproTrace) traces.push(event.data.reproTrace); });
      return channel;
    } as any;
    const baseline = await createAbsProjection(workspace, { document: workspace, contracts: { fields: {} }, generation: 'repro', baselineRef: 'repro',
      savedAbiHash: null, scope: { projectKey: 'own-synthetic-repro', pageId: 'main' } });
    try {
      const syntax = custom.syntax(source, workspace);
      const result = await prepareAbsNativeReconciliation(createAbsReconciler(baseline, source), {
        ...syntax, argumentOrder: (type, extra, fields) => syntax.argumentOrder?.(type, extra, fields) ?? shapes.get(type, extra, fields)?.argumentOrder,
        fieldDefinition: (type, name) => custom.field(type, name) ?? shapes.get(type)?.fields[name],
        blockContract: shapes.get, prepareBlock: custom.prepare, hostPrepared: type => !!custom.describe(type),
        variableCreation: { requestId: 'repro-explicit-intents', variables }, declaration: captureAbsVariableDeclarations(snapshot, shapes.get),
      }, async input => {
        try {
          const result = await evaluateNativeCandidate({ ...input, steps }, { assertCurrent() {}, timeoutMs: 10000 });
          stages.push({ stage: input.verify ? 'verify-complete-ABI' : 'binding', ok: true,
            hosted: input.hostCalls?.length ?? 0, nativeInstances: result.binding?.instances.length });
          return result;
        } catch (error: any) { stages.push({ stage: input.verify ? 'verify-complete-ABI' : 'binding', ok: false, code: error.code }); throw error; }
      }, () => {});
      return { ok: true, stages, traces, materialized: result.materialized, contracts: result.candidate.contracts, fullReadback: true };
    } catch (error: any) { return { ok: false, stages, traces, failure: { code: error.code, message: error.message, diagnostic: error.diagnostic } }; }
    finally { window.MessageChannel = Channel; projectDataRuntime.reset(); delete (window as any).fs; delete (window as any).path; }
  },
  inspectLogged(source: string, steps: any[]) {
    const json = steps.flatMap(step => step.definitions ?? []).find(value => value.type === 'custom_function_def');
    const kinds: any = { custom_function_def: 'definition', custom_function_call_return_advance: 'value-call', custom_function_call_advance: 'statement-call' };
    const describe = (type: string) => kinds[type] ? { protocol: { kind: kinds[type] },
      base: { argumentOrder: parseBlockDefinition(json, '')!.argsOrder } } : undefined;
    const options = customFunctionSyntax(source, { blocks: { blocks: [] } }, describe);
    const nodes = [...walkAbsRawSyntax(readAbsSyntax(source))].map(value => value.node).filter(node => kinds[node.type]);
    const name = (node: any) => (node.parameters.find((p: any) => p.name === 'FUNC_NAME') ?? node.parameters.filter((p: any) => !p.name)[0])?.token?.value;
    const extra = (node: any) => Object.hasOwn(node, 'extraState') ? node.extraState : options.prepareExtraState?.(node);
    const definitions = nodes.filter(node => node.type === 'custom_function_def');
    const keys = new Map(definitions.map((node, n) => [name(node), 'function-' + n]));
    return nodes.map(node => {
      const definition = definitions.find(value => name(value) === name(node));
      const state: any = extra(node), signature: any = definition && extra(definition);
      return { kind: kinds[node.type], type: node.type, functionKey: keys.get(name(node)) ?? 'missing',
        line: source.slice(0, node.start).split('\n').length, explicitExtraState: Object.hasOwn(node, 'extraState'),
        params: state?.params, extraCount: state?.extraCount, paramCount: state?.paramCount,
        matchesDefinition: !!definition && JSON.stringify(state?.params ?? []) === JSON.stringify(signature?.params ?? []) };
    });
  },
  prepare(libraries: any[], boardConfig: any = {}) {
    const steps: any[] = [{ kind: 'context', mode: 'arduino', boardConfig }];
    for (const library of libraries) steps.push(
      { kind: 'i18n', packageName: library.name, value: library.i18n },
      { kind: 'script', label: library.name + '/generator.js', source: library.source },
      { kind: 'definitions', libraryName: library.name, definitions: processJsonVar(processI18n(library.blocks, library.i18n), boardConfig) },
    );
    return steps;
  },
  async run(request: any) {
    const observations: any[] = [], traces: any[] = [], Channel = window.MessageChannel;
    let realms = 0;
    window.MessageChannel = function() {
      const channel = new Channel(); realms++;
      channel.port1.addEventListener('message', event => {
        if (event.data?.reproTrace) traces.push(event.data.reproTrace);
        if (event.data?.phase) observations.push({ phase: event.data.phase, elapsedMs: event.data.elapsedMs,
          ...(event.data.ui ? { ui: event.data.ui } : {}) });
      });
      return channel;
    } as any;
    const start = performance.now();
    try {
      const result = await evaluateNativeCandidate(request, { assertCurrent() {}, timeoutMs: 10000 });
      if (request.verify) createAbsReadbackVerifier(request.verify.state)(result.state as any);
      return { ok: true, elapsedMs: performance.now() - start, realms, observations, traces,
        state: result.state, blocks: [...indexAbsAbi(result.state as any).values()],
        ...(result.binding ? { binding: result.binding } : {}), fullReadback: !!request.verify };
    } catch (error: any) {
      return { ok: false, elapsedMs: performance.now() - start, realms, observations, traces,
        failure: { code: error.code, message: error.message, diagnostic: error.diagnostic } };
    } finally {
      window.MessageChannel = Channel;
      if (document.querySelectorAll('[data-blockly-native-candidate]').length) throw Error('The actual candidate iframe leaked');
    }
  },
} });
