const { randomUUID } = require('node:crypto');

/** Keep persistence behind the entire validation/npm/source transaction.
 * Editor content is saved separately; successful library edits are durable. */
class LibraryDependencySessions {
  constructor(libraries, { timeoutMs = 300_000 } = {}) {
    this.libraries = libraries;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }

  async run(operation, project, request, token) {
    const root = this.libraries.root(project);
    if (operation === 'recover') {
      if (request?.action === 'resolve' && this.sessions.has(root)) return {
        ok: false, code: 'LIBRARY_DEPENDENCY_RECOVERY_BUSY', message: 'A dependency transaction still owns this project; no decision was applied.' };
      try { return { ok: true, ...await this.libraries.recover(root, request),
        busy: this.libraries.queues.has(root) || this.sessions.has(root) }; }
      catch (error) { return { ok: false, code: error.code || 'LIBRARY_DEPENDENCY_RECOVERY_FAILED', message: error.message,
        ...(error.dependencyConflict ? { dependencyConflict: error.dependencyConflict } : {}) }; }
    }
    if (operation === 'status') {
      const status = this.libraries.status(root);
      return { ...status, busy: status.busy || this.sessions.has(root) };
    }
    if (operation === 'begin') {
      while (this.sessions.has(root)) await this.sessions.get(root).done;
      if (request?.requireClean && this.libraries.status(root).dirty) {
        throw new Error('LIBRARY_CHANGES_UNSAVED: 请先保存或放弃手动库变更。');
      }
      const session = { token: randomUUID() };
      session.done = new Promise(resolve => { session.release = resolve; });
      this.sessions.set(root, session);
      try {
        await this.libraries.queues.get(root);
        if (request?.requireClean && this.libraries.status(root).dirty) {
          throw new Error('LIBRARY_CHANGES_UNSAVED: 请先保存或放弃手动库变更。');
        }
        session.snapshot = JSON.parse(JSON.stringify({ manifest: this.libraries.effective(root), state: this.libraries.states.get(root) }));
        session.snapshot.locals = this.libraries.locals.snapshot(root);
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
          await this.libraries.save(root, { prepareSources: true, onPublish: () => { session.publishing = true; } });
        }
        if (operation === 'abort' && !session.publishing && (JSON.stringify(this.libraries.states.get(root)) !== JSON.stringify(session.snapshot.state)
          || this.libraries.locals.snapshot(root).size !== session.snapshot.locals.size)) {
          await this.libraries.restore(root, session.snapshot);
        }
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
    if (!['mutate', 'patch', 'removeLocal', 'prepare', 'save', 'discard', 'historyBegin', 'historyCommit', 'historyPreview', 'historyRestore', 'historyDiscard'].includes(operation)) throw new Error('Invalid library operation');
    if (token && !['mutate', 'patch', 'removeLocal'].includes(operation)) throw new Error('Invalid transaction operation');
    if (session && !token) {
      await session.done;
      return this.run(operation, root, request);
    }
    if (!token && ['mutate', 'removeLocal'].includes(operation)) {
      const { transaction } = await this.run('begin', root);
      try {
        await this.run(operation, root, request, transaction);
        return await this.run('end', root, undefined, transaction);
      } catch (error) {
        try { await this.run('abort', root, undefined, transaction); }
        catch (rollback) { throw new AggregateError([error, rollback], `${error.message}; 库还原失败: ${rollback.message}`); }
        throw error;
      }
    }
    return this.libraries[operation](root, request);
  }

  finish(root, session) {
    clearTimeout(session.timer);
    if (this.sessions.get(root) === session) this.sessions.delete(root);
    session.release();
  }

  expire(root, session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      void this.run('abort', root, undefined, session.token).catch(() => {});
    }, this.timeoutMs);
    session.timer.unref?.();
  }
}

module.exports = { LibraryDependencySessions };
