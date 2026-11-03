type SupervisionApi = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Registers cleanup before a domain RPC can acquire resources. */
export class SubappOwnerGuard {
  private opening?: Promise<string>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly controls = new Map<string, Record<string, unknown>>();
  private readonly tracked = new Map<string, { toolId: string; ownerSessionId: string }>();

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
    this.tracked.set(JSON.stringify([toolId, ownerSessionId]), { toolId, ownerSessionId });
    const result = await this.invoke({ action: 'track', generation, toolId, ownerSessionId });
    const context = result['context'] as { leaseFile?: unknown } | undefined;
    return typeof context?.leaseFile === 'string' ? { leaseFile: context.leaseFile } : {};
  }

  async release(toolId: string, ownerSessionId: string): Promise<boolean> {
    if (!this.opening) return false;
    const generation = await this.opening;
    const result = await this.invoke({ action: 'release', generation, toolId, ownerSessionId });
    this.tracked.delete(JSON.stringify([toolId, ownerSessionId]));
    return result['handled'] === true;
  }

  hasControlApi(): boolean { return !!this.api(); }

  async acquireAgent(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.invoke({ action: 'agent-acquire', generation: await this.generation(), sessionId });
    this.rememberControl(result);
    return result;
  }

  async agent(action: 'renew' | 'inspect' | 'retire' | 'recover', ownerLeaseId: string, sessionId: string,
    control?: unknown, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const ownerControl = control ?? this.controls.get(ownerLeaseId);
    const result = await this.invoke({ action: `agent-${action}`, generation: await this.generation(),
      ownerLeaseId, sessionId, ownerControl, ...extra });
    if ((action === 'renew' || action === 'recover') && result['ownerControl']) this.rememberControl(result);
    else if (ownerControl && typeof ownerControl === 'object' && result['ownerLeaseId'] === ownerLeaseId
      && result['sessionId'] === sessionId) this.controls.set(ownerLeaseId, { ...ownerControl });
    return result;
  }

  hasAgentControl(ownerLeaseId: string): boolean { return this.controls.has(ownerLeaseId); }

  private rememberControl(result: Record<string, unknown>): void {
    const control = result['ownerControl'] as Record<string, unknown> | undefined;
    if (typeof result['ownerLeaseId'] !== 'string' || control?.['version'] !== 1
      || control['ownerLeaseId'] !== result['ownerLeaseId'] || control['sessionId'] !== result['sessionId']
      || typeof control['capability'] !== 'string' || typeof control['generation'] !== 'string') {
      throw new Error('The main process did not prove a private Agent owner control.');
    }
    this.controls.set(result['ownerLeaseId'], { ...control });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      if (!this.opening) return;
      await this.opening;
      const results = await Promise.allSettled([
        ...[...this.controls.entries()].map(([owner, control]) => this.agent('retire', owner, String(control['sessionId']), control)),
        ...[...this.tracked.values()].map(({ toolId, ownerSessionId }) => this.release(toolId, ownerSessionId)),
      ]);
      // A service instance is not a renderer lifetime. Only native renderer
      // death/navigation may dispose another guard's independent new owners.
      if (results.some(result => result.status === 'rejected')) throw new Error('Owned Subapp resource cleanup could not be confirmed.');
    })();
  }

  private async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.api()!(input);
    if (result['ok'] !== true && !(input['action'] === 'agent-recover'
      && result['errorCode'] === 'SUBAPP_OWNER_RECOVERY_RECEIPT_EXPIRED')) throw Object.assign(new Error(String(result['error'] || JSON.stringify(result['errors']) || 'Subapp supervision failed')),
      { code: result['errorCode'] || 'SUBAPP_SUPERVISION_FAILED' });
    return result;
  }
}
