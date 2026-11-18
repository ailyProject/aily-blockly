const { randomUUID } = require('node:crypto');
const stableRequest = value => Array.isArray(value) ? value.map(stableRequest) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableRequest(value[key])])) : value;
const sameRequest = (left, right) => JSON.stringify(stableRequest({ ...left, operation: 'library-change' }))
  === JSON.stringify(stableRequest({ ...right, operation: 'library-change' }));
const fault = (code, message) => Object.assign(new Error(message), { code });
const notStarted = (code, message) => Object.assign(fault(code, message), { commandDispatched: false });
const isRequestId = value => typeof value === 'string' && /^env1-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const identifiedWrite = operation => operation === 'mutate' || operation === 'removeLocal';

/** Keep persistence behind the entire validation/npm/source transaction.
 * Editor content is saved separately; successful library edits are durable. */
class LibraryDependencySessions {
  capabilities() { return { dependencyEnvironmentVersion: 2 }; }

  constructor(libraries, { timeoutMs = 300_000, cancellationWaitMs = 5_000 } = {}) {
    this.libraries = libraries;
    this.timeoutMs = timeoutMs;
    this.cancellationWaitMs = cancellationWaitMs;
    this.sessions = new Map();
    this.requests = new Map();
  }

  async run(operation, project, request, token, control) {
    if (operation === 'capabilities') return this.capabilities();
    const root = this.libraries.root(project);
    if (operation === 'cancelEnvironment') {
      if (!isRequestId(request?.requestId)) throw new Error('Invalid original environment cancellation.');
      const key = root + '\0' + request.requestId;
      this.pruneRequests();
      const original = this.requests.get(key) || { retainUntil: Date.now() + this.timeoutMs };
      this.requests.set(key, original);
      this.revoke(root, request.requestId, original, fault('LIBRARY_OPERATION_CANCELLED', 'The original library request was stopped.'));
      if (original.done) await this.waitForCancellation(original.done);
      return this.libraries.observeEnvironment(root, request);
    }
    if (operation === 'recover') {
      if (request?.action === 'resolve' && this.sessions.has(root)) return {
        ok: false, code: 'LIBRARY_DEPENDENCY_RECOVERY_BUSY', message: 'A dependency transaction still owns this project; no decision was applied.' };
      try { return { ok: true, ...await this.libraries.recover(root, request),
        busy: this.libraries.queues.has(root) || this.sessions.has(root) }; }
      catch (error) { return { ok: false, code: error.code || 'LIBRARY_DEPENDENCY_RECOVERY_FAILED', message: error.message,
        ...(error.dependencyConflict ? { dependencyConflict: error.dependencyConflict } : {}) }; }
    }
    if (operation === 'status') {
      const status = this.libraries.queues.has(root) || this.sessions.has(root)
        ? this.libraries.status(root) : await this.libraries.settleEnvironment(root);
      return { ...status, busy: this.libraries.queues.has(root) || this.sessions.has(root) };
    }
    if (operation === 'observeEnvironment' || operation === 'historyDiscard') {
      // Original receipts and exact in-memory history cleanup own no writer.
      if (token) throw new Error('Invalid transaction operation');
      return this.libraries[operation](root, request);
    }
    if (!token && request?.requestId && operation === 'historyBegin') {
      const { requestId, expiresAt } = request;
      const assertActive = () => {
        if (!isRequestId(requestId) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
          throw notStarted('LIBRARY_OPERATION_EXPIRED', 'The original library preparation expired.');
      };
      assertActive();
      if (this.sessions.has(root) || this.libraries.queues.has(root))
        throw notStarted('LIBRARY_OPERATION_BUSY', 'A dependency writer already owns this project.');
      return this.libraries.historyBegin(root, request, { assertActive });
    }
    if (!token && request?.requestId && identifiedWrite(operation)) {
      return this.runIdentifiedWrite(operation, root, request);
    }
    if (operation === 'begin') {
      while (this.sessions.has(root)) await this.sessions.get(root).done;
      if (request?.requireClean && this.libraries.status(root).dirty) {
        throw notStarted('LIBRARY_CHANGES_UNSAVED', '请先保存或放弃手动库变更。');
      }
      const session = { token: randomUUID(), control };
      session.done = new Promise(resolve => { session.release = resolve; });
      this.sessions.set(root, session);
      try {
        await this.libraries.queues.get(root);
        control?.assertActive();
        if (request?.requireClean && this.libraries.status(root).dirty) {
          throw notStarted('LIBRARY_CHANGES_UNSAVED', '请先保存或放弃手动库变更。');
        }
        session.snapshot = JSON.parse(JSON.stringify({ manifest: this.libraries.effective(root), state: this.libraries.states.get(root) }));
        session.snapshot.locals = this.libraries.locals.snapshot(root);
        session.snapshot.environmentAttempt = await this.libraries.beginEnvironmentAttempt(root, request?.originalRequest, control);
        this.expire(root, session);
        return { transaction: session.token };
      } catch (error) { this.finish(root, session); throw error; }
    }
    const session = this.sessions.get(root);
    if (token && (!session || token !== session.token || session.closing)) throw new Error('Library transaction expired');
    if (operation === 'end' || operation === 'abort') {
      if (!token) throw new Error('Library transaction token required');
      session.closing = true;
      try {
        await this.libraries.queues.get(root)?.catch(() => {});
        if (operation === 'end') {
          session.control?.assertActive();
          await this.libraries.save(root, { prepareSources: true, control: session.control,
            onPublish: () => { session.publishing = true; } });
        }
        const shouldRestore = operation === 'abort' && (!session.publishing || !!session.control?.failure);
        if (shouldRestore && (session.publishing || JSON.stringify(this.libraries.states.get(root)) !== JSON.stringify(session.snapshot.state)
          || this.libraries.locals.snapshot(root).size !== session.snapshot.locals.size)) {
          await this.libraries.restore(root, session.snapshot);
        }
        if (shouldRestore) await this.libraries.finishAbortedEnvironmentAttempt(root, session.snapshot.environmentAttempt);
      } catch (error) {
        // The caller can still abort preparation. Once publication starts,
        // retain staged recovery state rather than hiding a partial save.
        session.closing = false;
        if (operation === 'abort') this.finish(root, session);
        else this.expire(root, session);
        throw error;
      }
      this.finish(root, session);
      return this.libraries.status(root);
    }
    if (!['mutate', 'patch', 'configure', 'reconcile', 'pendingEnvironment', 'settleLinkedEnvironment', 'removeLocal', 'prepare', 'save', 'discard', 'historyBegin', 'historyCommit', 'historyPreview', 'historyRestore'].includes(operation)) throw new Error('Invalid library operation');
    if (token && !['mutate', 'patch', 'removeLocal'].includes(operation)) throw new Error('Invalid transaction operation');
    if (session && !token) {
      await session.done;
      return this.run(operation, root, request);
    }
    if (!token && identifiedWrite(operation)) return this.runMutation(operation, root, request);
    return this.libraries[operation](root, request, session?.control);
  }

  async runIdentifiedWrite(operation, root, request) {
    const { requestId, expiresAt, ...input } = request;
    const now = Date.now();
    if (!isRequestId(requestId) || (expiresAt !== undefined
      && (!Number.isSafeInteger(expiresAt) || expiresAt > now + this.timeoutMs)))
      throw notStarted('LIBRARY_OPERATION_INVALID', 'Invalid library request deadline.');
    this.pruneRequests(now);
    const originalRequest = { requestId, ...input };
    const key = root + '\0' + requestId;
    const previous = this.requests.get(key);
    const retained = this.libraries.environment.find(root, requestId);
    if (previous?.request && !sameRequest(previous.request, originalRequest)
      || retained && !sameRequest(retained.record.request, originalRequest))
      throw new Error('Original environment arguments changed.');
    if (retained || previous?.done) return this.libraries.observeEnvironment(root, request);
    if (previous?.failure) throw previous.failure;

    const deadline = Math.min(expiresAt ?? Infinity, now + this.timeoutMs);
    const control = {
      request: originalRequest, retainUntil: deadline,
      assertActive() {
        if (control.failure) throw control.failure;
        if (Date.now() >= deadline) {
          control.failure = (control.done ? fault : notStarted)('LIBRARY_OPERATION_EXPIRED', 'The original library request expired.');
          throw control.failure;
        }
      },
    };
    this.requests.set(key, control);
    control.assertActive();
    if (this.sessions.has(root) || this.libraries.queues.has(root)) {
      control.failure = notStarted('LIBRARY_OPERATION_BUSY', 'A dependency writer already owns this project. This installation was not started.');
      throw control.failure;
    }
    const done = Promise.withResolvers();
    control.done = done.promise;
    const timer = setTimeout(() => this.revoke(root, requestId, control,
      fault('LIBRARY_OPERATION_EXPIRED', 'The original library request expired.')), deadline - Date.now());
    timer.unref?.();
    try { return await this.runMutation(operation, root, originalRequest, control); }
    finally { clearTimeout(timer); control.settled = true; done.resolve(); }
  }

  pruneRequests(now = Date.now()) {
    for (const [key, value] of this.requests)
      if (value.retainUntil <= now && (!value.done || value.settled)) this.requests.delete(key);
  }

  async runMutation(operation, root, request, control) {
    let transaction;
    try {
      transaction = (await this.run('begin', root, { originalRequest: request, requireClean: !!control }, undefined, control)).transaction;
      control?.assertActive();
      await this.run(operation, root, request, transaction);
      control?.assertActive();
      return await this.run('end', root, undefined, transaction);
    } catch (error) {
      try { if (transaction) await this.run('abort', root, undefined, transaction); }
      catch (rollback) {
        throw Object.assign(new AggregateError([error, rollback], `${error.message}; 库还原失败: ${rollback.message}`), { code: error.code });
      }
      throw control?.failure ?? error;
    }
  }

  revoke(root, requestId, control, error) {
    control.failure ??= error;
    control.stop ??= this.libraries.cancelEnvironmentWorkers(root, requestId).catch(() => {});
  }

  async waitForCancellation(done) {
    let timer;
    try {
      await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, this.cancellationWaitMs); })]);
    } finally { clearTimeout(timer); }
  }

  finish(root, session) {
    clearTimeout(session.timer);
    if (session.snapshot?.environmentAttempt) this.libraries.endEnvironmentAttempt(root, session.snapshot.environmentAttempt);
    if (this.sessions.get(root) === session) this.sessions.delete(root);
    session.release();
  }

  expire(root, session) {
    clearTimeout(session.timer);
    if (session.control) return;
    session.timer = setTimeout(() => {
      void this.run('abort', root, undefined, session.token).catch(() => {});
    }, this.timeoutMs);
    session.timer.unref?.();
  }
}

module.exports = { LibraryDependencySessions };
