const { randomUUID } = require('node:crypto');

/** Keep save/discard behind the entire Coder validation/npm/source transaction.
 * Only memory is checkpointed. The saved manifest is never used as a scratch file. */
class LibraryDependencySessions {
  constructor(libraries, { timeoutMs = 300_000 } = {}) {
    this.libraries = libraries;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }

  async run(operation, project, request, token) {
    const root = this.libraries.root(project);
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
        session.timer = setTimeout(() => {
          void this.run('abort', root, undefined, session.token).catch(() => {});
        }, this.timeoutMs);
        session.timer.unref?.();
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
        if (operation === 'abort' && (JSON.stringify(this.libraries.states.get(root)) !== JSON.stringify(session.snapshot.state)
          || this.libraries.locals.snapshot(root).size !== session.snapshot.locals.size)) {
          await this.libraries.restore(root, session.snapshot);
        }
      } finally { this.finish(root, session); }
      return this.libraries.status(root);
    }
    if (!['mutate', 'patch', 'removeLocal', 'save', 'discard'].includes(operation)) throw new Error('Invalid library operation');
    if (token && !['mutate', 'patch', 'removeLocal'].includes(operation)) throw new Error('Invalid transaction operation');
    if (session && !token) {
      await session.done;
      return this.run(operation, root, request);
    }
    return this.libraries[operation](root, request);
  }

  finish(root, session) {
    clearTimeout(session.timer);
    if (this.sessions.get(root) === session) this.sessions.delete(root);
    session.release();
  }
}

module.exports = { LibraryDependencySessions };
