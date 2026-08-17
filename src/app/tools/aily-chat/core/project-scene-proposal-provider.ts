import { PROJECT_SCENE_AGENT_TYPE } from './agent-identifiers';
import {
  beginProjectSceneProposalInvocation,
  type ProjectSceneProposalInvocationInput,
} from './project-scene-proposal-invocation';

export interface ProjectSceneAgentRunInput {
  readonly requestId: string;
  readonly agentType: typeof PROJECT_SCENE_AGENT_TYPE;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export type ProjectSceneAgentRunner = (
  input: ProjectSceneAgentRunInput,
) => Promise<unknown>;

export interface ProjectSceneProposalProviderOptions {
  readonly signal?: AbortSignal;
}

export type ProjectSceneProposalProvider = (
  input: ProjectSceneProposalInvocationInput,
  options?: ProjectSceneProposalProviderOptions,
) => Promise<Record<string, unknown>>;

/**
 * Adapts one standard visible ProjectSceneAgent turn to the Host provider contract.
 * The active request data stays in a bounded in-memory invocation; the model
 * receives only the requestId and must use the two scoped Scene proposal tools.
 */
export function createProjectSceneProposalProvider(
  runAgent: ProjectSceneAgentRunner,
): ProjectSceneProposalProvider {
  if (typeof runAgent !== 'function') {
    throw new TypeError('Project Scene proposal provider requires a headless Agent runner.');
  }
  return async (input, options = {}) => {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const invocation = beginProjectSceneProposalInvocation(input, options.signal);
    const prompt = createProjectSceneAgentPrompt(invocation.requestId);
    try {
      await waitForAgent(
        Promise.resolve().then(() => runAgent({
          requestId: invocation.requestId,
          agentType: PROJECT_SCENE_AGENT_TYPE,
          prompt,
          ...(options.signal ? { signal: options.signal } : {}),
        })),
        options.signal,
      );
      // If the Agent completed without the submit tool, convert the still-open
      // invocation into an explicit failure before awaiting its result.
      invocation.dispose();
      return await invocation.proposal;
    } catch (error) {
      invocation.reject(error);
      throw normalizeProviderError(error);
    } finally {
      invocation.dispose();
    }
  };
}

export function createProjectSceneAgentPrompt(requestId: string): string {
  return `A native v2 Project Scene generation request is active.
requestId: ${requestId}

Call get_project_scene_generation_context exactly once with this requestId. Infer only from that bounded context, then call submit_project_scene_wiring_intent exactly once with the same requestId. Submit semantic parts and nets only; Simulator owns package versions, IDs, layout, routing, diagnostics and Scene CAS. Do not save files, edit a Scene, call legacy schematic tools, or control Simulator/QEMU/GDB.`;
}

async function waitForAgent(
  execution: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  // Keep late runner failures observed when cancellation wins the race.
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
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
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
    : new Error('Project Scene proposal request was cancelled.');
}

function normalizeProviderError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error));
}
