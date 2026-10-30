import { Injectable } from '@angular/core';

/** In-process only: a JSON automation request cannot supply this key. */
export const SUBAPP_BROWSER_PRESENTATION = Symbol('subapp-browser-presentation');

interface Presentation {
  id: string; toolId: string; ownerSessionId: string; validate(): void;
  resolve(value: Record<string, unknown>): void; reject(error: unknown): void;
  close?: () => Promise<Record<string, unknown>>; revoked: boolean;
  completeMount?: () => void; mountCompleted?: boolean;
}
export interface SubappBrowserPresentationClaim {
  readonly ownerSessionId?: string;
  validate(): void;
  ready(value: Record<string, unknown>): void;
  failed(error: unknown): void;
  released(): Promise<void>;
}

/** Transfers a verified Agent lease to one explicitly identified View mount.
 * No endpoint, owner context or execution descriptor is accepted from the UI. */
@Injectable({ providedIn: 'root' })
export class SubappBrowserPresentationService {
  private readonly pending = new Map<string, Presentation>();
  private readonly active = new Map<string, Presentation>();

  prepare(toolId: string, ownerSessionId: string, validate: () => void) {
    validate();
    this.assertAvailable(toolId);
    let resolve!: (value: Record<string, unknown>) => void, reject!: (error: unknown) => void;
    const ready = new Promise<Record<string, unknown>>((done, fail) => { resolve = done; reject = fail; });
    // Startup can fail before the caller has awaited automation.openChildApp.
    void ready.catch(() => undefined);
    const presentation: Presentation = { id: crypto.randomUUID(), toolId, ownerSessionId,
      validate, resolve, reject, revoked: false };
    this.pending.set(presentation.id, presentation);
    return { id: presentation.id, ready };
  }

  /** Main registers only the exact UI mount opened with its in-process grant.
   * Completion is post-ACK UI bookkeeping, never a second resource close. */
  registerMount(toolId: string, presentationId: string, complete: () => void): void {
    const presentation = this.pending.get(presentationId)
      || [...this.active.values()].find(value => value.id === presentationId);
    if (!presentation || presentation.toolId !== toolId || presentation.revoked || presentation.completeMount) {
      throw new Error('Browser presentation mount grant is invalid or expired');
    }
    presentation.validate(); presentation.completeMount = complete;
  }

  claim(toolId: string, presentationId: string, close: () => Promise<Record<string, unknown>>): SubappBrowserPresentationClaim {
    let presentation: Presentation;
    if (presentationId) {
      const pending = this.pending.get(presentationId);
      if (!pending || pending.toolId !== toolId || pending.revoked) throw new Error('Browser presentation grant is invalid or expired');
      pending.validate();
      if (this.active.has(toolId)) throw new Error('Browser presentation already has an active View');
      this.pending.delete(presentationId); presentation = pending;
    } else {
      this.assertAvailable(toolId);
      presentation = { id: crypto.randomUUID(), toolId, ownerSessionId: '', validate: () => undefined,
        resolve: () => undefined, reject: () => undefined, revoked: false };
    }
    presentation.close = close;
    this.active.set(toolId, presentation);
    const validate = () => {
      if (presentation.revoked) throw new Error('Browser presentation grant has been revoked');
      presentation.validate();
    };
    return { ownerSessionId: presentation.ownerSessionId || undefined, validate,
      ready: value => presentation.resolve(value), failed: error => presentation.reject(error),
      released: async () => {
        this.completeMount(presentation);
        if (this.active.get(toolId) === presentation) this.active.delete(toolId);
      } };
  }

  async cancel(presentationId: string, error: unknown): Promise<void> {
    const presentation = this.pending.get(presentationId)
      || [...this.active.values()].find(value => value.id === presentationId);
    if (!presentation) return;
    presentation.revoked = true; presentation.reject(error);
    await presentation.close?.();
    this.completeMount(presentation);
    if (this.pending.get(presentation.id) === presentation) this.pending.delete(presentation.id);
  }

  /** Revocation closes only this owner's borrowed Views. Failed closes remain
   * registered so the lease release can retry before releasing its Runtime. */
  async closeOwner(ownerSessionId: string): Promise<void> {
    const owned = [...this.pending.values(), ...this.active.values()].filter(value => value.ownerSessionId === ownerSessionId);
    const results = await Promise.allSettled(owned.map(value => this.cancel(value.id, new Error('Agent presentation owner released'))));
    const errors = results.flatMap(value => value.status === 'rejected' ? [value.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Agent Browser View cleanup remains unconfirmed');
  }

  private assertAvailable(toolId: string): void {
    if (this.active.has(toolId) || [...this.pending.values()].some(value => value.toolId === toolId)) {
      throw new Error('Browser presentation already exists; close its current View before presenting an Agent owner');
    }
  }

  private completeMount(presentation: Presentation): void {
    if (presentation.mountCompleted) return;
    presentation.completeMount?.();
    presentation.mountCompleted = true;
  }
}
