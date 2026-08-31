import type {
  SubappHostProviderRecord,
  SubappHostProviderTransport,
} from './subapp-host-provider-dispatcher';

/**
 * Minimal structural view of ChildToolProcessService. Keeping this adapter
 * free of Angular lets other generic Subapp hosts provide the same boundary.
 */
export interface ChildToolProcessMessageBridge {
  onMessage(
    toolId: string,
    listener: (message: SubappHostProviderRecord) => void,
  ): () => void;
  sendMessage(
    toolId: string,
    message: SubappHostProviderRecord,
  ): Promise<void>;
}

export function createSubappHostProviderChildToolTransport(
  toolIdValue: string,
  bridge: ChildToolProcessMessageBridge,
): SubappHostProviderTransport {
  const toolId = String(toolIdValue || '').trim();
  if (!toolId) throw new TypeError('Child Tool ID is required.');
  if (
    !bridge
    || typeof bridge.onMessage !== 'function'
    || typeof bridge.sendMessage !== 'function'
  ) {
    throw new TypeError('Child Tool process message bridge is invalid.');
  }
  return Object.freeze({
    onMessage(listener: (message: SubappHostProviderRecord) => void) {
      return bridge.onMessage(toolId, listener);
    },
    async send(message: SubappHostProviderRecord) {
      await bridge.sendMessage(toolId, message);
    },
  });
}
