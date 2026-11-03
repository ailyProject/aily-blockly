import { captureProjectCopyLibraries } from './project-copy-libraries';

describe('project copy effective library snapshot', () => {
  const project = '/isolated/project';
  let previous: any;
  let state: any;
  let manager: any;
  beforeEach(() => {
    previous = window['libraryDependencies'];
    state = { dirty: true, busy: false, manifest: { dependencies: { example: '2.0.0' }, metadata: { retain: true } } };
    manager = { status: jasmine.createSpy('status').and.callFake(async () => state),
      save: jasmine.createSpy('save'), discard: jasmine.createSpy('discard') };
    window['libraryDependencies'] = manager;
  });
  afterEach(() => { window['libraryDependencies'] = previous; });

  it('captures detached immutable effective metadata without saving or discarding the source', async () => {
    const snapshot = await captureProjectCopyLibraries(project);
    expect(JSON.parse(snapshot.manifestText)).toEqual(state.manifest);
    await snapshot.assertCurrent();
    state.manifest.dependencies.example = '3.0.0';
    expect(JSON.parse(snapshot.manifestText).dependencies.example).toBe('2.0.0');
    await expectAsync(snapshot.assertCurrent()).toBeRejectedWithError(/Effective library dependencies changed/);
    expect(manager.status).toHaveBeenCalledWith(project);
    expect(manager.save).not.toHaveBeenCalled(); expect(manager.discard).not.toHaveBeenCalled();
  });

  it('also admits complete settled library facts', async () => {
    state.dirty = false;
    const snapshot = await captureProjectCopyLibraries(project);
    await expectAsync(snapshot.assertCurrent()).toBeResolved();
  });

  it('rejects a library operation that becomes busy after the snapshot', async () => {
    const snapshot = await captureProjectCopyLibraries(project);
    state.busy = true;
    await expectAsync(snapshot.assertCurrent()).toBeRejectedWithError(/still running/);
  });

  for (const [label, facts] of [
    ['absent', undefined], ['missing manifest', { dirty: false, busy: false }],
    ['null manifest', { dirty: false, busy: false, manifest: null }],
    ['array manifest', { dirty: false, busy: false, manifest: [] }],
    ['non-boolean busy', { dirty: false, busy: 'false', manifest: {} }],
    ['missing dirty', { busy: false, manifest: {} }],
  ] as Array<[string, any]>) it(`rejects ${label} facts rather than assuming a clean library manager`, async () => {
    manager.status.and.resolveTo(facts);
    await expectAsync(captureProjectCopyLibraries(project)).toBeRejectedWithError(/current library-manager facts/);
    expect(manager.save).not.toHaveBeenCalled(); expect(manager.discard).not.toHaveBeenCalled();
  });

  it('requires the host library manager to exist', async () => {
    window['libraryDependencies'] = undefined;
    await expectAsync(captureProjectCopyLibraries(project)).toBeRejectedWithError(/current library-manager facts/);
  });

  it('does not convert a failed host observation into a snapshot', async () => {
    manager.status.and.rejectWith(new Error('library observer unavailable'));
    await expectAsync(captureProjectCopyLibraries(project)).toBeRejectedWithError('library observer unavailable');
  });
});
