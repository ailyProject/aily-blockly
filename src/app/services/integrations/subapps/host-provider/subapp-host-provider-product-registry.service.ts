import { Injectable } from '@angular/core';

import type {
  SubappHostProviderTransport,
} from './subapp-host-provider-dispatcher';

const PORTABLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface SubappHostProviderProductOpenContext {
  readonly toolId: string;
  readonly hostInstanceId: string;
  readonly transport: SubappHostProviderTransport;
}

export interface SubappHostProviderProductSession {
  close(): void | Promise<void>;
}

export interface SubappHostProviderProductFactory {
  open(
    context: SubappHostProviderProductOpenContext,
  ): SubappHostProviderProductSession
    | Promise<SubappHostProviderProductSession>;
}

/**
 * Product-neutral registry used by the generic Child Tool Host. A Subapp
 * without a registered product factory keeps its existing lifecycle.
 */
@Injectable({ providedIn: 'root' })
export class SubappHostProviderProductRegistryService {
  private readonly factories = new Map<
    string,
    SubappHostProviderProductFactory
  >();

  register(
    toolIdValue: string,
    factory: SubappHostProviderProductFactory,
  ): () => void {
    const toolId = requirePortableIdentifier(toolIdValue, 'toolId');
    if (!factory || typeof factory.open !== 'function') {
      throw new TypeError('Host Provider product factory is invalid.');
    }
    if (this.factories.has(toolId)) {
      throw new Error(`Host Provider product factory is already registered: ${toolId}`);
    }
    this.factories.set(toolId, factory);
    return () => {
      if (this.factories.get(toolId) === factory) {
        this.factories.delete(toolId);
      }
    };
  }

  async open(
    context: SubappHostProviderProductOpenContext,
  ): Promise<SubappHostProviderProductSession | null> {
    const toolId = requirePortableIdentifier(context.toolId, 'toolId');
    requirePortableIdentifier(context.hostInstanceId, 'hostInstanceId');
    if (
      !context.transport
      || typeof context.transport.send !== 'function'
      || typeof context.transport.onMessage !== 'function'
    ) {
      throw new TypeError('Host Provider product transport is invalid.');
    }
    const factory = this.factories.get(toolId);
    if (!factory) return null;
    const session = await factory.open(context);
    if (!session || typeof session.close !== 'function') {
      throw new TypeError('Host Provider product factory returned an invalid session.');
    }
    return session;
  }
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !PORTABLE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}
