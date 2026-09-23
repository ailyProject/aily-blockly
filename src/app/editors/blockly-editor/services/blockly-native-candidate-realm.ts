import { NativeCandidateWorkspace } from './blockly-native-candidate-workspace';
import { bindNativeAbs } from './blockly-native-abs-binding';
import { serializeAbsFailure } from '../../../integrations/blockly/abs/abs-diagnostics';
import type { NativeCandidateRequest } from './blockly-native-candidate-protocol';
import { createNativeStructureObserver } from './blockly-native-structure';
import { createProjectGenerator, type BlocklyGeneratorMode } from './blockly-generator-factory';
import { verifyNativeAbi } from './blockly-native-abi-verification';
import type { Generator } from 'blockly';
import { NativeCandidateModels } from './blockly-native-models';
import { nativeCandidateValues } from './blockly-native-values';
import { adaptBundledArduinoProcedureCalls } from './blockly-bundled-procedure-generator';
import { adaptArduinoTextLiterals } from './blockly-arduino-text-literals';
import { NativeRegistrationTasks } from './blockly-native-registration-tasks';
import { GeneratorProjectEffects } from './generator-project-effects';
import { NativeUiTasks, nativeUiSemanticSnapshot } from './blockly-native-ui-tasks';
import { createNativeCandidateGraphics } from './blockly-native-graphics';
import { isAilyDataRef, projectDataFieldReference, registerProjectDataBlockDefinition, wrapProjectDataGeneratorFunctions, installProjectDataImageCache } from '@domain/project/project-data/public-api';

/** Bundled with the actual host implementations into an independent JavaScript realm. */
export function installNativeCandidateRealm(): void {
  const realm = window as any;
  const native = realm.Blockly;
  const observer = createNativeStructureObserver();
  let consumed = false;
  window.addEventListener('message', async (event: MessageEvent<NativeCandidateRequest>) => {
    if (consumed || event.source !== window.parent || event.ports.length !== 1) return;
    consumed = true;
    const port = event.ports[0], send = port.postMessage.bind(port);
    const request = event.data;
    const errors: Error[] = [];
    let workspace: any;
    let phase = 'initialization';
    let registering = true;
    const tasks = new NativeRegistrationTasks(realm.setTimeout.bind(realm), realm.clearTimeout.bind(realm));
    const uiTasks = new NativeUiTasks();
    const deny = (name: string) => () => {
      const message = `Native candidate does not support ${name}. Phase: ${phase}`;
      const error = Object.assign(new Error(message), { code: 'ABS_NATIVE_EFFECT_UNSUPPORTED', diagnostic: {
        reason: name, hint: `Use synchronous generator APIs. Phase: ${phase}. Repair library compatibility; do not retry unchanged ABS or recover the project.`,
      } });
      errors.push(error); tasks.fail(error); throw error;
    };
    // Sticky errors: a library catching a rejected side effect cannot make it supported.
    Object.defineProperty(realm, 'setTimeout', { configurable: false, writable: false, value: (callback: unknown, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') return deny('string timer callbacks')();
      if (!registering) return uiTasks.set(() => Reflect.apply(callback, realm, args), delay);
      const origin = phase;
      return tasks.set(() => {
        const previous = phase; phase = `deferred ${origin}`;
        try { const value = Reflect.apply(callback, realm, args); assertClean(); return value; }
        finally { phase = previous; }
      }, delay);
    } });
    Object.defineProperty(realm, 'clearTimeout', { configurable: false, writable: false, value: (id: number) => {
      if (id < 0) uiTasks.clear(id); else tasks.clear(id);
    } });
    for (const name of ['queueMicrotask', 'setInterval', 'requestIdleCallback',
      'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'BroadcastChannel', 'open']) {
      Object.defineProperty(realm, name, { value: deny(name), configurable: false, writable: false });
    }
    Object.defineProperty(Promise.prototype, 'then', { value: deny('Promise continuations'), configurable: false, writable: false });
    realm.projectService = new Proxy(Object.create(null), { get: (_target, name) => deny(`projectService.${String(name)}`)() });
    const onError = (event: ErrorEvent) => { const error = event.error instanceof Error ? event.error : new Error(event.message); errors.push(error); tasks.fail(error); event.preventDefault(); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', event => { tasks.fail(event.reason); event.preventDefault(); });
    const assertClean = () => { if (errors.length) throw errors[0]; tasks.assertClean(); uiTasks.assertClean(); };
    // Registration is replay input. A configuration/generator callback cannot add
    // another registry effect and silently promote it to transaction-owned state.
    const assertRegistration = () => { if (!registering) deny('block registration after replay')(); };
    native.Blocks = new Proxy(native.Blocks, {
      set: (target, key, value) => { assertRegistration(); return Reflect.set(target, key, value, target); },
      defineProperty: (target, key, descriptor) => { assertRegistration(); return Reflect.defineProperty(target, key, descriptor); },
      deleteProperty: (target, key) => { assertRegistration(); return Reflect.deleteProperty(target, key); },
    });
    const declarations = new Map<string, Record<string, any>>();
    const register = native.defineBlocksWithJsonArray.bind(native);
    native.defineBlocksWithJsonArray = (definitions: any[]) => {
      assertRegistration();
      register(definitions);
      for (const definition of definitions) {
        declarations.set(definition.type, structuredClone(definition));
        observer.observeNativeBlockDefinition(native.Blocks[definition.type]);
      }
    };
    try {
      const values = nativeCandidateValues(request.values);
      const readPrepared = (ref: unknown) => {
        try { return values.get(ref); }
        catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); tasks.fail(error); throw error; }
      };
      Object.defineProperty(realm, 'ailyProjectData', { configurable: false, writable: false, value: Object.freeze({
        isDataRef: isAilyDataRef, getPrepared: readPrepared,
        getPreparedFieldPayload: (block: any, name: string) => {
          try {
            return readPrepared(projectDataFieldReference(block?.getFieldValue?.(name), name));
          } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); tasks.fail(error); throw error; }
        },
      }) });
      values.assertReferences(request.verify?.state ?? request.abs ?? request.blocks);
      native.Events.disable();
      workspace = createNativeCandidateGraphics(native, uiTasks);
      installProjectDataImageCache(realm, () => workspace, assertClean);
      native.getMainWorkspace = () => workspace;
      realm.global = window;
      realm.__BLOCKLY_LIB_I18N__ = Object.create(null);
      let mode: BlocklyGeneratorMode | undefined;
      let generator: Generator | undefined;
      // Observe only replay registrations and blocks actually created for native
      // discovery. Wrapping every bundled init would invalidate host provenance
      // even for model blocks that are deliberately prepared by pure adapters.
      for (const step of request.steps) {
        phase = step.kind === 'script' ? `replay ${step.label}` : `replay ${step.kind}`;
        if (step.kind === 'script') {
          const script = document.createElement('script');
          script.textContent = step.source;
          document.head.appendChild(script); script.remove();
          if (mode === 'arduino') {
            adaptBundledArduinoProcedureCalls(generator);
            adaptArduinoTextLiterals(generator);
          }
        } else if (step.kind === 'definitions') {
          for (const definition of step.definitions) registerProjectDataBlockDefinition(definition, step.libraryName);
          native.defineBlocksWithJsonArray(step.definitions);
        }
        else if (step.kind === 'context') {
          if (step.mode && step.mode !== mode) {
            if (mode) throw new Error('Native replay cannot switch generator mode within a session.');
            mode = step.mode;
            generator = createProjectGenerator(mode);
            realm.Arduino = mode === 'arduino' ? generator : undefined;
            realm.MPY = realm.MicropPython = mode === 'micropython' ? generator : undefined;
            realm.Python = mode === 'python' ? generator : undefined;
          }
          if (step.messages) Object.assign(native.Msg, step.messages);
          realm.boardConfig = step.boardConfig; realm.packageJson = step.packageJson;
        } else if (step.kind === 'messages') Object.assign(native.Msg, step.value);
        else if (step.kind === 'i18n') realm.__BLOCKLY_LIB_I18N__[step.packageName] = step.value;
        else throw new Error('Unknown native replay step.');
        assertClean();
      }
      await tasks.drain();
      assertClean();
      if (workspace.getAllBlocks(false).length || workspace.getAllVariables().length) throw new Error('Native registration created workspace state.');
      registering = false;
      if (generator) wrapProjectDataGeneratorFunctions(generator, Object.keys(generator.forBlock), readPrepared);
      if (generator) new GeneratorProjectEffects(realm).wrap(generator);
      if (generator) for (const [blockType, handler] of Object.entries(generator.forBlock)) {
        generator.forBlock[blockType] = function (...args) {
          try { const value = handler.apply(this, args); assertClean(); return value; }
          catch (error) {
            if ((error as any)?.code === 'ABS_NATIVE_EFFECT_UNSUPPORTED') {
              (error as any).diagnostic.blockType ??= blockType;
            }
            throw error;
          }
        };
      }
      phase = request.verify ? 'final ABI verification' : request.abs !== undefined ? 'ABS binding' : 'explicit block configuration';
      const models = new NativeCandidateModels(workspace, request.variables);
      if (!request.verify) models.load();
      const execution = new NativeCandidateWorkspace(native, workspace, observer, assertClean, models, request.creations, declarations);
      const binding = request.abs !== undefined ? bindNativeAbs(request.abs, execution, declarations, request.identities, values.materialize, request.hostCalls,
        request.modelRequestId && generator
          ? { generator, requestId: request.modelRequestId } : undefined) : undefined;
      if (!request.verify && !binding) for (const operation of request.blocks) execution.create(operation);
      if (!request.verify) {
        execution.initializeViews();
        uiTasks.drain(() => nativeUiSemanticSnapshot(native, workspace));
      }
      const result = request.verify ? await verifyNativeAbi(native, workspace, request.verify, generator, assertClean, readPrepared, uiTasks)
        : uiTasks.withoutScheduling(() => ({ ...execution.result(), ...(binding ? { binding: binding() } : {}) }));
      assertClean();
      values.assertReferences(result.state);
      phase = 'candidate cleanup';
      workspace.dispose(); workspace = undefined; assertClean();
      send({ ok: true, result });
    } catch (error) {
      try { workspace?.dispose(); } catch { /* The entire independent Realm is discarded by the host. */ }
      send({ ok: false, error: serializeAbsFailure(error) });
    } finally { tasks.dispose(); uiTasks.dispose(); port.close(); }
  });
}
