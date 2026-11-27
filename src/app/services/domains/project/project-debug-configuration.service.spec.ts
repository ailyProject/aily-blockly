import {
  createEmptyProjectDebugConfiguration, PROJECT_ARTIFACT_MANIFEST_PATH,
  ProjectDebugConfigurationService, sha256ProjectSource,
} from './project-debug-configuration.service';

describe('initial editor breakpoint projection', () => {
  const oldRevision = '1'.repeat(64), newRevision = '2'.repeat(64);
  let service: ProjectDebugConfigurationService;
  let files: Map<string, string>;
  let resolveSync: jasmine.Spy;
  let pending: Array<(execution: { currentProjectPath: string } | null) => void>;
  let previous: Record<string, PropertyDescriptor | undefined>;

  function manifest(root: string, revision: string, source: string) {
    files.set(root + '/' + PROJECT_ARTIFACT_MANIFEST_PATH, JSON.stringify({
      files: [{ role: 'source-map', sha256: revision }], build: { source: { sha256: source } },
    }));
  }

  beforeEach(() => {
    previous = {};
    files = new Map();
    pending = [];
    resolveSync = jasmine.createSpy('resolveBuildProjectPath').and.returnValue('/latest');
    const env = {
      fs: {
        existsSync: (p: string) => files.has(p), readFileSync: (p: string) => files.get(p),
        writeFileSync: (p: string, text: string) => files.set(p, text),
      },
      path: { join: (...parts: string[]) => parts.join('/') },
      builder: {
        isolatedBuildExecutionVersion: 1, resolveBuildProjectPath: resolveSync,
        resolveBuildExecutionInWorker: () => new Promise(resolve => pending.push(resolve)),
      },
    };
    for (const [key, value] of Object.entries(env)) {
      previous[key] = Object.getOwnPropertyDescriptor(window, key);
      Object.defineProperty(window, key, { configurable: true, value });
    }
    service = new ProjectDebugConfigurationService();
  });

  afterEach(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
  });

  it('publishes saved intents immediately and joins the verified artifact with the latest workspace hash', async () => {
    files.set('/project/aily-debug.json', JSON.stringify({
      ...createEmptyProjectDebugConfiguration(),
      breakpoints: [{ blockId: 'a', sourceMapRevision: oldRevision, enabled: true }],
    }));
    const source = await sha256ProjectSource('current code');
    manifest('/old', oldRevision, source);
    expect(service.initializeForEditor('/project').configuration.breakpoints.length).toBe(1);
    expect(resolveSync).not.toHaveBeenCalled();
    await service.updateWorkspaceGeneratedCode('/project', 'current code');
    pending[0]({ currentProjectPath: '/old' });
    await Promise.resolve();
    expect(service.snapshot.sourceMapRevision).toBe(oldRevision);
    expect(service.snapshot.buildConsistency).toBe('current');
    expect(resolveSync).not.toHaveBeenCalled();
  });

  it('preserves edits made while the retained build is being checked', async () => {
    manifest('/old', oldRevision, 'a'.repeat(64));
    service.initializeForEditor('/project');
    service.markWorkspaceDirty('/project');
    pending[0]({ currentProjectPath: '/old' });
    await Promise.resolve();
    expect(service.snapshot.buildConsistency).toBe('dirty');
  });

  it('discards an old lookup when the same project is reopened after switching projects', async () => {
    manifest('/old', oldRevision, 'a'.repeat(64));
    service.initializeForEditor('/a');
    service.initializeForEditor('/b');
    service.initializeForEditor('/a');
    pending[0]({ currentProjectPath: '/old' });
    pending[1]({ currentProjectPath: '/old' });
    pending[2](null);
    await Promise.resolve();
    expect(service.snapshot.projectPath).toBe('/a');
    expect(service.snapshot.sourceMapRevision).toBe('');
    expect(resolveSync).not.toHaveBeenCalled();
  });

  it('gives a successful build and a later breakpoint write precedence over the initial worker', async () => {
    const source = await sha256ProjectSource('new');
    manifest('/old', oldRevision, source);
    manifest('/latest', newRevision, source);
    service.initializeForEditor('/project');
    await service.updateWorkspaceGeneratedCode('/project', 'new', { refreshArtifact: true });
    pending[0]({ currentProjectPath: '/old' });
    await Promise.resolve();
    expect(service.snapshot.sourceMapRevision).toBe(newRevision);
    expect(service.requireBindableSourceMapRevision('/project')).toBe(newRevision);

    service.initializeForEditor('/project');
    service.upsertBreakpoint('/project', { blockId: 'a', enabled: false, sourceMapRevision: newRevision });
    pending[1]({ currentProjectPath: '/old' });
    await Promise.resolve();
    expect(service.snapshot.configuration.breakpoints[0].enabled).toBeFalse();
    expect(service.snapshot.sourceMapRevision).toBe(newRevision);
  });

  it('checks synchronously on hosts without the worker bridge', () => {
    delete window['builder'].resolveBuildExecutionInWorker;
    manifest('/latest', newRevision, 'a'.repeat(64));
    expect(service.initializeForEditor('/project').sourceMapRevision).toBe(newRevision);
    expect(resolveSync).toHaveBeenCalledOnceWith('/project');
  });
});
