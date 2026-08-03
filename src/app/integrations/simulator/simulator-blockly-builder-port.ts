import type {
  SimulatorBlocklyBuilderPort,
  SimulatorBlocklyBuildRequest,
} from './simulator-build-execution-port';

export interface SimulatorBlocklyBuilderServicePort {
  buildActiveBlocklyProject(input: {
    readonly projectPath: string;
    readonly graphSemanticRevision: string;
    readonly requestId: string;
  }): Promise<unknown>;
  cancelActiveBlocklyProjectBuild(requestId: string): void;
}

/**
 * Adapts the product Builder service without exposing it to the Host SDK or
 * granting it any Simulator lifecycle authority.
 */
export function createSimulatorBlocklyBuilderPort(
  service: SimulatorBlocklyBuilderServicePort,
): SimulatorBlocklyBuilderPort {
  if (
    !service
    || typeof service.buildActiveBlocklyProject !== 'function'
    || typeof service.cancelActiveBlocklyProjectBuild !== 'function'
  ) {
    throw new TypeError('Blockly Builder service port is invalid.');
  }
  return Object.freeze({
    async build(
      request: SimulatorBlocklyBuildRequest,
      signal: AbortSignal,
    ): Promise<unknown> {
      throwIfAborted(signal);
      const completion = service.buildActiveBlocklyProject({
        projectPath: request.projectRoot,
        graphSemanticRevision: request.graphSemanticRevision,
        requestId: request.requestId,
      });
      let cancellationSent = false;
      const cancel = () => {
        if (cancellationSent) return;
        cancellationSent = true;
        service.cancelActiveBlocklyProjectBuild(request.requestId);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const result = await completion;
        throwIfAborted(signal);
        return result;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Blockly Build request was cancelled.');
}
