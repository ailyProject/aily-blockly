import { mountNormalBrowserApplication, type NormalBrowserPublicationContext } from './normal-browser-application';
import type { SimulatorCapturedProjectActivation, SimulatorProjectActivationPort } from '../simulator/simulator-web-project-activation';

/** Real small Angular composition with explicit project/publication and failed
 * cleanup fixtures. No firmware compilation, filesystem, Artifact, lease or MCU is used. */
describe('normal Browser borrowed project and cleanup intent', () => {
  type Application = Awaited<ReturnType<typeof mountNormalBrowserApplication>>;
  const applications: Application[] = [];
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('section');
    container.style.height = '480px'; document.body.appendChild(container);
  });
  afterEach(async () => {
    for (const application of applications.splice(0)) {
      let closed = await application.close();
      if (!closed.ok) closed = await application.close();
      expect(closed.ok).toBeTrue();
    }
    container.remove();
  });

  function fixture() {
    const owner = new AbortController();
    const captured: SimulatorCapturedProjectActivation = Object.freeze({
      path: 'blockly-project:test', projectSessionId: 'blockly-session:test', signal: owner.signal,
      requireCurrent: () => owner.signal.throwIfAborted(),
    });
    let captureFailure: Error | null = null, publicationReads = 0;
    const externalClose = jasmine.createSpy('external owner close');
    const project: SimulatorProjectActivationPort & { close(): void } = {
      captureCurrentProjectActivation() { if (captureFailure) throw captureFailure; return captured; },
      projectActivation$: { subscribe: () => ({ unsubscribe() {} }) },
      currentProjectPath$: { subscribe: () => ({ unsubscribe() {} }) },
      close: externalClose,
    };
    let context!: NormalBrowserPublicationContext;
    async function mount() {
      const application = await mountNormalBrowserApplication({ container, project,
        createPublication(value) {
          context = value;
          return { async readPublication() { publicationReads++; throw new Error('No publication was supplied by this fixture.'); } };
        } });
      applications.push(application); await application.ready; return application;
    }
    return { owner, captured, project, externalClose, mount, context: () => context,
      failCapture(error: Error) { captureFailure = error; }, publicationReads: () => publicationReads };
  }

  it('passes the same external port and capture into trusted publication without Coder UI', async () => {
    const source = fixture(), application = await source.mount();
    expect(source.context().project).toBe(source.project);
    expect(source.context().project.captureCurrentProjectActivation()).toBe(source.captured);
    expect(source.context().getClient()).toBeNull();
    expect(container.querySelector('app-browser-project-view')).toBeNull();
    expect(document.querySelectorAll('iframe').length).toBe(0);
    expect(application.snapshot().projectSource).toBe('borrowed-external');
    expect((await application.close()).ok).toBeTrue();
    expect(source.externalClose).not.toHaveBeenCalled(); expect(source.owner.signal.aborted).toBeFalse();
  });

  it('rejects mixed external authority and an owned Coder document before mounting', async () => {
    const source = fixture(), editorURL = new URL('/coder/', location.origin).href;
    await expectAsync(mountNormalBrowserApplication({ container, project: source.project,
      editor: { editorURL, bridgeModuleURL: new URL('browser-project-port.mjs', editorURL).href } }))
      .toBeRejectedWithError(/original external project or the owned Coder document/);
    expect(container.children.length).toBe(0); expect(source.externalClose).not.toHaveBeenCalled();
  });

  it('uses the original external owner check before starting a Simulator presentation', async () => {
    const source = fixture(), application = await source.mount();
    source.owner.abort(new DOMException('Original Blockly owner ended.', 'AbortError'));
    expect(() => application.openSimulator()).toThrow();
    expect(container.querySelector('app-simulator-web')).toBeNull();
    expect(source.publicationReads()).toBe(0); expect(source.externalClose).not.toHaveBeenCalled();
  });

  it('keeps application close intent after a failed original close and blocks both callers and UI', async () => {
    const source = fixture(), application = await source.mount();
    let attempts = 0;
    spyOn(source.context().documents, 'closeDocument').and.callFake(async () => {
      if (++attempts === 1) throw new Error('Original cleanup has not acknowledged.');
    });
    const first = await application.close();
    expect(first.ok).toBeFalse();
    expect(application.snapshot().applicationCloseRequested).toBeTrue();
    expect(() => application.openSimulator()).toThrowError(/requested cleanup/);
    await expectAsync(application.closeProject()).toBeRejectedWithError(/closing or closed/);
    (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
    await Promise.resolve();
    expect(source.publicationReads()).toBe(0); expect(container.querySelector('app-simulator-web')).toBeNull();
    expect((await application.close()).ok).toBeTrue(); expect(attempts).toBeGreaterThanOrEqual(2);
    expect(source.externalClose).not.toHaveBeenCalled(); expect(source.owner.signal.aborted).toBeFalse();
  });

  it('retries presentation cleanup before accepting the still-owned external project again', async () => {
    const source = fixture(), application = await source.mount();
    let attempts = 0;
    spyOn(source.context().documents, 'closeDocument').and.callFake(async () => {
      if (++attempts === 1) throw new Error('Original presentation cleanup is unconfirmed.');
    });
    await expectAsync(application.closeProject()).toBeRejectedWithError(/unconfirmed/);
    expect(() => application.openSimulator()).toThrowError(/requested cleanup/);
    await application.closeProject();
    expect(application.snapshot().projectCloseRequested).toBeFalse();
    const originalCaptureFailure = new Error('Original port is consulted again.');
    source.failCapture(originalCaptureFailure);
    expect(() => application.openSimulator()).toThrow(originalCaptureFailure);
    expect(source.externalClose).not.toHaveBeenCalled(); expect(source.owner.signal.aborted).toBeFalse();
    expect(source.publicationReads()).toBe(0);
  });
});
