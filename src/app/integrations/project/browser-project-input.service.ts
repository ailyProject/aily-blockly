import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import type { SimulatorCapturedProjectActivation, SimulatorProjectActivationPort } from '../simulator/simulator-web-project-activation';

interface InputBinding {
  readonly port: SimulatorProjectActivationPort;
  readonly lifetime: AbortController;
  readonly subscriptions: Set<() => void>;
  captured: SimulatorCapturedProjectActivation | null;
  original: SimulatorCapturedProjectActivation | null;
}

/** Adapts the currently selected application's original workspace owner. Coder
 * and Blockly may supply the same port; this service owns no projects/files. */
@Injectable({ providedIn: 'root' })
export class BrowserProjectInputService implements SimulatorProjectActivationPort {
  private current: InputBinding | null = null;
  private readonly retired = new Set<InputBinding>();
  private readonly ownedCleanup = new Set<{ close(): Promise<void> }>();
  private readonly activationSubject = new Subject<unknown>();
  private readonly pathSubject = new BehaviorSubject('');
  readonly projectActivation$ = this.activationSubject.asObservable();
  readonly currentProjectPath$ = this.pathSubject.asObservable();

  bind(port: SimulatorProjectActivationPort, owner: AbortSignal): { close(): Promise<void>; snapshot(): object } {
    owner.throwIfAborted();
    if (this.current) this.retire(this.current);
    if (this.retired.size) throw new Error('The previous Browser project input cleanup remains unconfirmed.');
    const binding: InputBinding = { port, lifetime: new AbortController(), subscriptions: new Set(), captured: null, original: null };
    this.current = binding;
    const changed = () => {
      if (this.current !== binding) return;
      const original = port.captureCurrentProjectActivation();
      // Path and activation can both announce the same original generation.
      // A duplicate cannot revoke an in-flight composition or replace capture.
      if (binding.original === original) return;
      binding.original = original; binding.captured = null;
      this.pathSubject.next(original?.path ?? '');
      this.activationSubject.next(null);
    };
    try {
      const activation = port.projectActivation$.subscribe(changed);
      binding.subscriptions.add(() => activation.unsubscribe());
      const paths = port.currentProjectPath$.subscribe(changed);
      binding.subscriptions.add(() => paths.unsubscribe());
      const ended = () => { try { this.retire(binding); } catch { /* Exact failed subscriptions remain retained. */ } };
      owner.addEventListener('abort', ended, { once: true });
      binding.subscriptions.add(() => owner.removeEventListener('abort', ended));
      owner.throwIfAborted();
      changed();
    } catch (error) {
      try { this.retire(binding); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Browser project input setup cleanup remains unconfirmed.'); }
      throw error;
    }
    return Object.freeze({
      close: async () => { this.retire(binding); },
      snapshot: () => ({ current: this.current === binding, closed: binding.lifetime.signal.aborted,
        subscriptions: binding.subscriptions.size, retainedCleanupResponsibility: this.retired.has(binding) }),
    });
  }

  captureCurrentProjectActivation(): SimulatorCapturedProjectActivation | null {
    const binding = this.current;
    if (!binding || binding.lifetime.signal.aborted) return null;
    const original = binding.port.captureCurrentProjectActivation();
    if (!original) return null;
    original.requireCurrent();
    if (binding.original !== original || !binding.captured) {
      const captured: SimulatorCapturedProjectActivation = Object.freeze({
        path: original.path, projectSessionId: original.projectSessionId,
        signal: AbortSignal.any([original.signal, binding.lifetime.signal]),
        requireCurrent: () => {
          binding.lifetime.signal.throwIfAborted(); original.requireCurrent();
          if (this.current !== binding || binding.port.captureCurrentProjectActivation() !== original) {
            throw new DOMException('The original Browser project input changed.', 'AbortError');
          }
        },
      });
      binding.original = original; binding.captured = captured;
    }
    return binding.captured;
  }

  private retire(binding: InputBinding): void {
    this.retired.add(binding);
    binding.lifetime.abort(new DOMException('The Browser project input owner ended.', 'AbortError'));
    if (this.current === binding) {
      this.current = null; this.pathSubject.next(''); this.activationSubject.next(null);
    }
    const failures: unknown[] = [];
    for (const cleanup of binding.subscriptions) {
      try { cleanup(); binding.subscriptions.delete(cleanup); } catch (error) { failures.push(error); }
    }
    if (!binding.subscriptions.size) this.retired.delete(binding);
    if (failures.length) throw new AggregateError(failures, 'Browser project input subscriptions remain unconfirmed.');
  }

  snapshot() {
    return { selectedOwner: this.current !== null, retiredInputs: this.retired.size,
      retainedResources: this.ownedCleanup.size,
      retainedCleanupResponsibility: this.retired.size !== 0 || this.ownedCleanup.size !== 0 };
  }

  /** An ended presentation transfers only its original cleanup responsibility,
   * so destroying that component cannot discard a failed or pending close. */
  retainCleanup(resource: { close(): Promise<void> }): Promise<void> {
    this.ownedCleanup.add(resource);
    return Promise.resolve().then(() => resource.close()).then(() => { this.ownedCleanup.delete(resource); });
  }

  async retryCleanup(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.retired].map(binding => Promise.resolve().then(() => this.retire(binding))),
      ...[...this.ownedCleanup].map(resource => this.retainCleanup(resource)),
    ]);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Browser project input cleanup remains unconfirmed.');
  }
}
