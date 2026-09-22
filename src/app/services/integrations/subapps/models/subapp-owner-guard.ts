type SupervisionApi = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Registers cleanup before a domain RPC can acquire resources. */
export class SubappOwnerGuard {
  private opening?: Promise<string>;
  private closed = false;
  private closing?: Promise<void>;

  private api(): SupervisionApi | undefined {
    if (typeof window === 'undefined') return undefined;
    const session = (window as any).electronAPI?.childToolSession || window['childToolSession'];
    if (session && !session.superviseOwner) throw new Error('Restart the host to enable Subapp owner supervision');
    return session?.superviseOwner;
  }

  private async generation(): Promise<string> {
    if (!this.opening) this.opening = this.invoke({ action: 'connect' }).then(result => {
      if (typeof result['generation'] !== 'string' || !result['generation']) throw new Error('Invalid Subapp owner generation');
      return result['generation'];
    });
    return this.opening;
  }

  /** Native batch launch owns registration after its supervised process exists. */
  async nativeOwner(ownerSessionId: string): Promise<{ generation: string; ownerSessionId: string }> {
    if (!ownerSessionId || !this.api() || this.closed) throw new Error('Native Subapp owner supervision is unavailable');
    const generation = await this.generation();
    if (this.closed) throw new Error('Subapp owner guard is closed');
    return { generation, ownerSessionId };
  }

  async track(toolId: string, ownerSessionId: string): Promise<{ leaseFile?: string }> {
    if (!ownerSessionId || !this.api()) return {};
    if (this.closed) throw new Error('Subapp owner guard is closed');
    const generation = await this.generation();
    if (this.closed) throw new Error('Subapp owner guard is closed');
    const result = await this.invoke({ action: 'track', generation, toolId, ownerSessionId });
    const context = result['context'] as { leaseFile?: unknown } | undefined;
    return typeof context?.leaseFile === 'string' ? { leaseFile: context.leaseFile } : {};
  }

  async release(toolId: string, ownerSessionId: string): Promise<boolean> {
    if (!this.opening) return false;
    const generation = await this.opening;
    const result = await this.invoke({ action: 'release', generation, toolId, ownerSessionId });
    return result['handled'] === true;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      if (!this.opening) return;
      const generation = await this.opening;
      await this.invoke({ action: 'dispose', generation });
    })();
  }

  private async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.api()!(input);
    if (result['ok'] !== true) throw Object.assign(new Error(String(result['error'] || JSON.stringify(result['errors']) || 'Subapp supervision failed')),
      { code: result['errorCode'] || 'SUBAPP_SUPERVISION_FAILED' });
    return result;
  }
}
