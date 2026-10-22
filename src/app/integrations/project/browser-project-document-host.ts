export interface BrowserProjectDocumentResource {
  close(): Promise<void>;
}

export interface BrowserProjectDocumentClient<TPort> extends BrowserProjectDocumentResource {
  readonly ready: Promise<void>;
  readonly activation: TPort;
  snapshot(): object;
}

export interface BrowserProjectDocumentHostOptions<TPort> {
  readonly window: Window;
  readonly document: Document;
  /** Captured application deployment URL, never a route or child message. */
  readonly url: string;
  /** Application/project owner. A presentation's visibility is not ownership. */
  readonly owner: AbortSignal;
  /** Return the created client before awaiting its ready promise. */
  connect(childWindow: Window, signal: AbortSignal): BrowserProjectDocumentClient<TPort> | Promise<BrowserProjectDocumentClient<TPort>>;
  bind(port: TPort, signal: AbortSignal): BrowserProjectDocumentResource;
  onError?(error: unknown): void;
}

interface OwnedResource {
  readonly original: BrowserProjectDocumentResource;
  closed: boolean;
  pending: Promise<void> | null;
}

/** Owns one real iframe document and its original connection. The frame remains
 * under one body container for its entire lifetime: views project its geometry
 * without moving, reconnecting or changing the document. No project/file table,
 * Session, account grant or automatic navigation recovery is introduced here. */
export function createBrowserProjectDocumentHost<TPort>(options: BrowserProjectDocumentHostOptions<TPort>) {
  options.owner.throwIfAborted();
  const { window: hostWindow, document: hostDocument } = options;
  const url = new URL(options.url);
  const secure = url.protocol === 'https:' || url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!secure || url.href !== options.url || url.origin !== hostWindow.location.origin
    || url.username || url.password || url.search || url.hash || /[%\\]/.test(url.href)
    || !url.pathname.endsWith('/') || hostDocument.defaultView !== hostWindow
    || hostWindow.document !== hostDocument || !hostDocument.body) {
    throw new TypeError('An exact same-origin application directory and its owning document are required.');
  }

  const lifetime = new AbortController();
  const container = hostDocument.createElement('div');
  container.dataset['browserProjectDocumentHost'] = '';
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1;';
  const frame = hostDocument.createElement('iframe');
  frame.title = 'Browser project document';
  frame.src = url.href;
  frame.style.cssText = 'position:fixed;border:0;visibility:hidden;pointer-events:none;';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  container.appendChild(frame);

  const resources: OwnedResource[] = [];
  const cleanups = new Set<() => void>();
  let client: BrowserProjectDocumentClient<TPort> | null = null;
  let binding: BrowserProjectDocumentResource | null = null;
  let view: { anchor: HTMLElement; visible: boolean } | null = null;
  let viewObserver: ResizeObserver | null = null;
  let observerCleanup: (() => void) | null = null;
  let viewObserverCleanupFailed = false;
  let loadCount = 0, navigationDetected = false, closeRequested = false;
  let setupPending = true, frameRemoved = false, closeFailures = 0;
  let closing: Promise<void> | null = null;
  let resolveLoaded!: () => void, rejectLoaded!: (reason: unknown) => void;
  const loaded = new Promise<void>((resolve, reject) => { resolveLoaded = resolve; rejectLoaded = reject; });
  const aborted = () => new DOMException('The original Browser project document owner ended.', 'AbortError');
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* An observer cannot veto revocation. */ } };
  const requireCurrent = () => {
    lifetime.signal.throwIfAborted(); options.owner.throwIfAborted();
    if (frameRemoved || !frame.isConnected || hostDocument.defaultView !== hostWindow) throw aborted();
  };
  const own = (original: BrowserProjectDocumentResource) => {
    if (!resources.some(resource => resource.original === original)) resources.push({ original, closed: false, pending: null });
  };
  const removeFrame = () => {
    if (frameRemoved) return;
    container.remove(); frameRemoved = true;
  };
  const hideFrame = () => {
    frame.style.visibility = 'hidden'; frame.style.pointerEvents = 'none';
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
  };
  function projectView() {
    if (closeRequested || !view?.visible || !view.anchor.isConnected) { hideFrame(); return; }
    const rect = view.anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { hideFrame(); return; }
    frame.style.left = `${rect.left}px`; frame.style.top = `${rect.top}px`;
    frame.style.width = `${rect.width}px`; frame.style.height = `${rect.height}px`;
    frame.style.visibility = 'visible'; frame.style.pointerEvents = 'auto';
    frame.setAttribute('aria-hidden', 'false'); frame.tabIndex = 0;
  }
  function detachCurrentView() {
    view = null; hideFrame();
    if (observerCleanup) {
      const original = observerCleanup;
      try { original(); cleanups.delete(original); }
      catch (error) { viewObserverCleanupFailed = true; report(error); }
    }
  }
  function closeResource(resource: OwnedResource): Promise<void> {
    if (resource.closed) return Promise.resolve();
    if (resource.pending) return resource.pending;
    const task = Promise.resolve().then(() => resource.original.close()).then(() => { resource.closed = true; })
      .finally(() => { if (resource.pending === task) resource.pending = null; });
    resource.pending = task; return task;
  }
  function revoke() {
    if (!closeRequested) {
      closeRequested = true; lifetime.abort(aborted()); rejectLoaded(aborted());
      detachCurrentView();
    }
    for (const cleanup of cleanups) {
      try { cleanup(); cleanups.delete(cleanup); } catch (error) { report(error); }
    }
  }
  function close(): Promise<void> {
    revoke();
    if (closing) return closing;
    const task = Promise.resolve().then(async () => {
      // Start original close before awaiting ready/setup: close itself may be
      // what settles a pending client readiness promise. Late imports are still
      // adopted below and receive their own original close exactly once here.
      const attempted = new Set(resources);
      const early = Promise.allSettled([...attempted].reverse().map(closeResource));
      await ready.catch(() => undefined);
      const late = resources.filter(resource => !attempted.has(resource)).reverse().map(closeResource);
      const results = [...await early, ...await Promise.allSettled(late)];
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length || cleanups.size) {
        closeFailures++;
        throw new AggregateError(failures.map(result => result.reason), 'Original Browser project document cleanup remains unconfirmed.');
      }
      removeFrame();
    }).finally(() => { if (closing === task) closing = null; });
    closing = task;
    void task.catch(() => { /* The owner retains this exact host for an explicit retry. */ });
    return task;
  }
  const onLoad = () => {
    loadCount++;
    if (loadCount === 1 && !closeRequested) { resolveLoaded(); return; }
    // WindowProxy identity survives navigation. A second document never earns
    // the old project's input binding; the original client owns any missing ACK.
    navigationDetected = true; revoke(); removeFrame();
    void close().catch(report);
  };
  const onOwnerEnded = () => { void close().catch(report); };
  const onPageHide = () => { void close().catch(report); };
  frame.addEventListener('load', onLoad);
  cleanups.add(() => frame.removeEventListener('load', onLoad));
  options.owner.addEventListener('abort', onOwnerEnded, { once: true });
  cleanups.add(() => options.owner.removeEventListener('abort', onOwnerEnded));
  hostWindow.addEventListener('pagehide', onPageHide);
  cleanups.add(() => hostWindow.removeEventListener('pagehide', onPageHide));
  hostWindow.addEventListener('resize', projectView);
  cleanups.add(() => hostWindow.removeEventListener('resize', projectView));
  hostWindow.addEventListener('scroll', projectView, true);
  cleanups.add(() => hostWindow.removeEventListener('scroll', projectView, true));

  const ready = Promise.resolve().then(async () => {
    await loaded; requireCurrent();
    const childWindow = frame.contentWindow;
    if (!childWindow) throw new Error('The original Browser project document Window is unavailable.');
    client = await options.connect(childWindow, lifetime.signal); own(client);
    requireCurrent();
    await client.ready; requireCurrent();
    binding = options.bind(client.activation, lifetime.signal); own(binding);
    requireCurrent();
  }).finally(() => { setupPending = false; });
  void ready.catch(error => { report(error); void close().catch(report); });

  try { hostDocument.body.appendChild(container); options.owner.throwIfAborted(); }
  catch (error) { revoke(); void close().catch(report); throw error; }

  return Object.freeze({
    ready, frame,
    attachView(anchor: HTMLElement, visible = true) {
      requireCurrent();
      if (anchor.ownerDocument !== hostDocument) throw new TypeError('The presentation anchor must belong to the original host document.');
      detachCurrentView();
      if (viewObserver) throw new Error('The original presentation observer cleanup remains unconfirmed.');
      const original = { anchor, visible }; view = original;
      const Observer = (hostWindow as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      if (Observer) {
        const observer = new Observer(projectView); viewObserver = observer;
        const cleanup = () => {
          observer.disconnect();
          if (viewObserver === observer) viewObserver = null;
          if (observerCleanup === cleanup) observerCleanup = null;
          viewObserverCleanupFailed = false;
        };
        observerCleanup = cleanup; cleanups.add(cleanup);
        observer.observe(anchor);
      }
      projectView();
      return Object.freeze({
        setVisible(value: boolean) { if (view === original && !closeRequested) { original.visible = value; projectView(); } },
        detach() { if (view === original) detachCurrentView(); },
      });
    },
    close,
    snapshot() {
      return { closeRequested, ownerAborted: lifetime.signal.aborted, setupPending, loadCount, navigationDetected,
        viewAttached: view !== null, viewVisible: Boolean(view?.visible), viewObserverActive: viewObserver !== null,
        frameAttached: !frameRemoved && frame.isConnected,
        clientCreated: client !== null, inputBound: binding !== null && !closeRequested,
        ownedResources: resources.filter(resource => !resource.closed).length,
        pendingOriginalClose: resources.filter(resource => resource.pending !== null).length,
        originalResourcesClosed: closeRequested && !setupPending && resources.every(resource => resource.closed),
        listeners: cleanups.size, closeFailures,
        retainedCleanupResponsibility: viewObserverCleanupFailed || closeRequested && (setupPending || resources.some(resource => !resource.closed)
          || cleanups.size !== 0 || !frameRemoved),
        // Resource close is not evidence of Worker physical exit or Node/Main business cleanup.
        WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false };
    },
  });
}
