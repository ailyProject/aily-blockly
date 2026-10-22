import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserProjectDocumentHost, type BrowserProjectDocumentClient } from './browser-project-document-host.js';

/** Structural DOM/client doubles cover only owner boundaries. These are not
 * Chrome navigation, iframe continuity, account or Workbench acceptance. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { delayedConnect?: boolean; delayedReady?: boolean; delayedClose?: boolean; failInputClose?: boolean } = {}) {
  let connects = 0, binds = 0, clientCloses = 0, inputCloses = 0, observers = 0, frameAppends = 0;
  let bindingSignal: AbortSignal | null = null;
  let failInputClose = Boolean(options.failInputClose);
  const owner = new AbortController();
  const connected = deferred<BrowserProjectDocumentClient<object>>();
  const clientReady = deferred<void>(), clientClosed = deferred<void>();
  const errors: unknown[] = [];
  const originalActivation = {};
  const originalChild = {} as Window;
  const hostWindow = new EventTarget() as EventTarget & Record<string, unknown>;
  const hostDocument = {} as Document;
  class Element extends EventTarget {
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    readonly children: Element[] = [];
    readonly ownerDocument = hostDocument;
    parent: Element | null = null;
    title = ''; src = ''; tabIndex = 0;
    readonly contentWindow = originalChild;
    constructor(readonly tagName: string) { super(); }
    get parentElement() { return this.parent; }
    get isConnected(): boolean { return this === body || Boolean(this.parent?.isConnected); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    appendChild(child: Element) {
      if (child.parent) child.remove();
      child.parent = this; this.children.push(child);
      if (child.tagName === 'iframe') frameAppends++;
      return child;
    }
    remove() {
      if (!this.parent) return;
      const old = this.parent; this.parent = null;
      old.children.splice(old.children.indexOf(this), 1);
    }
    getBoundingClientRect() { return { left: 10, top: 20, width: 400, height: 300 }; }
  }
  const body = new Element('body');
  Object.assign(hostDocument, { body, defaultView: hostWindow, createElement: (name: string) => new Element(name) });
  class Observer {
    private connected = false;
    observe() { if (!this.connected) { this.connected = true; observers++; } }
    disconnect() { if (this.connected) { this.connected = false; observers--; } }
  }
  Object.assign(hostWindow, { document: hostDocument, location: { origin: 'https://application.invalid' }, ResizeObserver: Observer });
  const client: BrowserProjectDocumentClient<object> = {
    ready: options.delayedReady ? clientReady.promise : Promise.resolve(), activation: originalActivation,
    async close() {
      clientCloses++;
      clientReady.reject(new DOMException('Original client closed before ready.', 'AbortError'));
      if (options.delayedClose) await clientClosed.promise;
    },
    snapshot: () => ({}),
  };
  // A structural fixture has no application observer for this optional promise.
  void clientReady.promise.catch(() => undefined);
  const host = createBrowserProjectDocumentHost({
    window: hostWindow as unknown as Window, document: hostDocument,
    url: 'https://application.invalid/editor/', owner: owner.signal,
    connect(childWindow) {
      assert.equal(childWindow, originalChild); connects++;
      return options.delayedConnect ? connected.promise : client;
    },
    bind(port, signal) {
      assert.equal(port, originalActivation); binds++; bindingSignal = signal;
      return { async close() {
        inputCloses++;
        if (failInputClose) { failInputClose = false; throw new Error('Original input cleanup failed.'); }
      } };
    },
    onError: error => errors.push(error),
  });
  const anchor = () => { const result = new Element('anchor'); body.appendChild(result); return result as unknown as HTMLElement; };
  const load = () => host.frame.dispatchEvent(new Event('load'));
  return { host, owner, client, connected, clientReady, clientClosed, originalChild, anchor, load, errors,
    signal: () => bindingSignal,
    counters: () => ({ connects, binds, clientCloses, inputCloses, observers, frameAppends }) };
}

test('hiding, detaching and a late view preserve one original document connection', async () => {
  const f = fixture(); f.load(); await f.host.ready;
  const originalFrame = f.host.frame, originalParent = originalFrame.parentElement;
  assert(originalParent, 'The owned frame must stay in its original fixed container.');
  const first = f.host.attachView(f.anchor());
  first.setVisible(false); first.setVisible(true); first.detach();
  const second = f.host.attachView(f.anchor());
  first.detach(); first.setVisible(false);
  assert.equal(f.host.frame, originalFrame); assert.equal(f.host.frame.parentElement, originalParent);
  assert.equal(f.host.frame.contentWindow, f.originalChild);
  assert.equal(f.host.snapshot().viewAttached, true); assert.equal(f.host.snapshot().viewVisible, true);
  assert.equal(f.host.snapshot().loadCount, 1); assert.equal(f.signal()?.aborted, false);
  assert.deepEqual(f.counters(), { connects: 1, binds: 1, clientCloses: 0, inputCloses: 0, observers: 1, frameAppends: 1 });
  second.detach(); await f.host.close();
  assert.equal(f.host.snapshot().retainedCleanupResponsibility, false); assert.equal(f.counters().observers, 0);
});

test('application owner revokes synchronously and closes original resources without claiming business ACK', async () => {
  const f = fixture(); f.load(); await f.host.ready;
  f.host.attachView(f.anchor()); f.owner.abort();
  assert.equal(f.signal()?.aborted, true); assert.equal(f.host.snapshot().inputBound, false);
  assert.equal(f.host.snapshot().viewObserverActive, false);
  await f.host.close();
  assert.equal(f.counters().clientCloses, 1); assert.equal(f.counters().inputCloses, 1);
  const result = f.host.snapshot();
  assert.equal(result.frameAttached, false); assert.equal(result.listeners, 0);
  assert.equal(result.ownedResources, 0); assert.equal(result.originalResourcesClosed, true);
  assert.equal(result.WorkerPhysicalExitConfirmed, false); assert.equal(result.NodeBusinessACK, false); assert.equal(result.MainBusinessACK, false);
});

test('navigation removes the replaced document while retaining its original pending cleanup responsibility', async () => {
  const f = fixture({ delayedClose: true }); f.load(); await f.host.ready;
  f.host.attachView(f.anchor()); f.load();
  assert.equal(f.signal()?.aborted, true); assert.equal(f.host.snapshot().navigationDetected, true);
  assert.equal(f.host.snapshot().frameAttached, false); assert.equal(f.host.snapshot().listeners, 0);
  let settled = false;
  const closing = f.host.close().then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.host.snapshot().retainedCleanupResponsibility, true);
  assert.equal(f.host.snapshot().originalResourcesClosed, false);
  f.clientClosed.resolve(); await closing;
  assert.equal(f.host.snapshot().retainedCleanupResponsibility, false);
  assert.equal(f.counters().connects, 1);
});

test('failed original input cleanup remains retryable without repeating the successful client close', async () => {
  const f = fixture({ failInputClose: true }); f.load(); await f.host.ready;
  await assert.rejects(f.host.close(), /cleanup remains unconfirmed/);
  assert.equal(f.host.snapshot().retainedCleanupResponsibility, true);
  assert.equal(f.host.snapshot().frameAttached, true); assert.equal(f.host.snapshot().ownedResources, 1);
  assert.equal(f.host.snapshot().closeFailures, 1);
  await f.host.close();
  assert.equal(f.counters().inputCloses, 2); assert.equal(f.counters().clientCloses, 1);
  assert.equal(f.host.snapshot().retainedCleanupResponsibility, false);
});

test('an original import that settles after close is adopted for cleanup and never binds input', async () => {
  const f = fixture({ delayedConnect: true }); f.load();
  await Promise.resolve(); await Promise.resolve();
  const closing = f.host.close();
  assert.equal(f.host.snapshot().retainedCleanupResponsibility, true);
  f.connected.resolve(f.client);
  await assert.rejects(f.host.ready); await closing;
  assert.equal(f.counters().connects, 1); assert.equal(f.counters().binds, 0); assert.equal(f.counters().clientCloses, 1);
  assert.equal(f.host.snapshot().retainedCleanupResponsibility, false);
});

test('close starts the original client cleanup before awaiting a pending ready promise', async () => {
  const f = fixture({ delayedReady: true }); f.load();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await f.host.close(); await assert.rejects(f.host.ready);
  assert.equal(f.counters().clientCloses, 1); assert.equal(f.counters().binds, 0);
  assert.equal(f.host.snapshot().ownedResources, 0); assert.equal(f.host.snapshot().listeners, 0);
  assert.equal(f.host.snapshot().retainedCleanupResponsibility, false);
});
