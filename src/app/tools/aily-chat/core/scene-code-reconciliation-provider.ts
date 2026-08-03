import { SCENE_CODE_RECONCILIATION_AGENT_TYPE } from './agent-identifiers';
import {
  beginSceneCodeReconciliationInvocation,
  type SceneCodeReconciliationCandidate,
  type SceneCodeReconciliationInvocationInput,
} from './scene-code-reconciliation-invocation';

export interface SceneCodeReconciliationAgentRunInput {
  readonly requestId: string;
  readonly agentType: typeof SCENE_CODE_RECONCILIATION_AGENT_TYPE;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export type SceneCodeReconciliationAgentRunner = (
  input: SceneCodeReconciliationAgentRunInput,
) => Promise<unknown>;

export interface SceneCodeReconciliationProviderOptions {
  readonly signal?: AbortSignal;
}

export type SceneCodeReconciliationProvider = (
  input: SceneCodeReconciliationInvocationInput,
  options?: SceneCodeReconciliationProviderOptions,
) => Promise<SceneCodeReconciliationCandidate>;

export function createSceneCodeReconciliationProvider(
  runAgent: SceneCodeReconciliationAgentRunner,
): SceneCodeReconciliationProvider {
  if (typeof runAgent !== 'function') {
    throw new TypeError(
      'Scene code reconciliation provider requires a scoped Agent runner.',
    );
  }
  return async (input, options = {}) => {
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    const invocation = beginSceneCodeReconciliationInvocation(
      input,
      options.signal,
    );
    try {
      await waitForAgent(
        Promise.resolve().then(() => runAgent({
          requestId: invocation.requestId,
          agentType: SCENE_CODE_RECONCILIATION_AGENT_TYPE,
          prompt: createSceneCodeReconciliationAgentPrompt(
            invocation.requestId,
          ),
          ...(options.signal ? { signal: options.signal } : {}),
        })),
        options.signal,
      );
      invocation.dispose();
      return await invocation.candidate;
    } catch (error) {
      invocation.reject(error);
      throw normalizeProviderError(error);
    } finally {
      invocation.dispose();
    }
  };
}

export function createSceneCodeReconciliationAgentPrompt(
  requestId: string,
): string {
  return `A native Scene-to-Blockly code reconciliation request is active.
requestId: ${requestId}

Call get_scene_code_reconciliation_context exactly once with this requestId. Reconcile only the returned complete ABS working copy with the exact native Scene revision, then call submit_scene_code_reconciliation_candidate exactly once with the same requestId. Submit either a complete changed ABS program or already-aligned. Do not edit Blockly or files, request approval, build firmware, call legacy SchematicAgent/AWS tools, or control Simulator/QEMU/GDB.`;
}

async function waitForAgent(
  execution: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  void execution.catch(() => undefined);
  if (!signal) {
    await execution;
    return;
  }
  if (signal.aborted) throw abortReason(signal);
  let removeAbortListener = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener =
      () => signal.removeEventListener('abort', onAbort);
  });
  try {
    await Promise.race([execution, aborted]);
  } finally {
    removeAbortListener();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Scene code reconciliation request was cancelled.');
}

function normalizeProviderError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
