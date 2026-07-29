import {
  deriveProjectBuildConsistency,
  getProjectBreakpointMarkerState,
  ProjectDebugConfigurationService,
  sha256ProjectSource,
} from './project-debug-configuration.service';

describe('ProjectDebugConfigurationService', () => {
  const projectPath = 'C:/projects/demo';
  const configurationPath = `${projectPath}/aily-debug.json`;
  const artifactPath =
    `${projectPath}/.build/aily-artifact-manifest.json`;
  const revision = 'a'.repeat(64);
  const artifactSourceSha256 = 'c'.repeat(64);
  let files: Map<string, string>;
  let previousFs: unknown;
  let previousPath: unknown;

  beforeEach(() => {
    files = new Map<string, string>();
    previousFs = (window as any).fs;
    previousPath = (window as any).path;
    (window as any).fs = {
      existsSync: (filePath: string) => files.has(filePath),
      readFileSync: (filePath: string) => files.get(filePath),
      writeFileSync: (filePath: string, value: string) => {
        files.set(filePath, value);
      },
    };
    (window as any).path = {
      join: (...parts: string[]) => parts.join('/'),
    };
  });

  afterEach(() => {
    (window as any).fs = previousFs;
    (window as any).path = previousPath;
  });

  it('loads the project configuration and exact Artifact source-map revision', () => {
    files.set(configurationPath, JSON.stringify({
      schemaVersion: 1,
      kind: 'aily-project-debug-configuration',
      breakpoints: [{
        blockId: 'block-1',
        sourceMapRevision: revision,
        enabled: true,
      }],
    }));
    files.set(artifactPath, JSON.stringify({
      build: {
        source: {
          sha256: artifactSourceSha256,
        },
      },
      debug: {
        sourceMapPath: 'debug/block-source-map.json',
      },
      files: [
        {
          role: 'source-map',
          path: 'other.json',
          sha256: 'b'.repeat(64),
        },
        {
          role: 'source-map',
          path: 'debug/block-source-map.json',
          sha256: revision,
        },
      ],
    }));

    const service = new ProjectDebugConfigurationService();
    const state = service.refresh(projectPath);

    expect(state.configuration.breakpoints.length).toBe(1);
    expect(state.configuration.breakpoints[0].blockId).toBe('block-1');
    expect(state.sourceMapRevision).toBe(revision);
    expect(state.artifactSourceSha256).toBe(artifactSourceSha256);
    expect(state.buildConsistency).toBe('workspace-unknown');
    expect(state.configurationError).toBe('');
    expect(state.sourceMapError).toBe('');
  });

  it('publishes batch breakpoint mutations to aily-debug.json', () => {
    files.set(artifactPath, JSON.stringify({
      build: {
        source: {
          sha256: artifactSourceSha256,
        },
      },
      files: [{
        role: 'source-map',
        path: 'block-source-map.json',
        sha256: revision,
      }],
    }));
    const service = new ProjectDebugConfigurationService();

    service.upsertBreakpoints(projectPath, [
      {
        blockId: 'block-2',
        sourceMapRevision: revision,
        enabled: false,
      },
      {
        blockId: 'block-1',
        sourceMapRevision: revision,
        enabled: true,
      },
    ]);
    service.removeBreakpoints(projectPath, ['block-2']);

    const written = JSON.parse(files.get(configurationPath) || '{}');
    expect(written.breakpoints).toEqual([{
      blockId: 'block-1',
      sourceMapRevision: revision,
      enabled: true,
    }]);
    expect(service.snapshot.configuration.breakpoints).toEqual(
      written.breakpoints,
    );
    expect(service.snapshot.sourceMapRevision).toBe(revision);
  });

  it('distinguishes current, stale, and unknown marker states', () => {
    const breakpoint = {
      blockId: 'block-1',
      sourceMapRevision: revision,
      enabled: true,
    };

    expect(getProjectBreakpointMarkerState(breakpoint, revision))
      .toBe('enabled');
    expect(getProjectBreakpointMarkerState(breakpoint, 'b'.repeat(64)))
      .toBe('stale-enabled');
    expect(getProjectBreakpointMarkerState(
      { ...breakpoint, enabled: false },
      '',
    )).toBe('revision-unknown-disabled');
    expect(getProjectBreakpointMarkerState(
      breakpoint,
      revision,
      'dirty',
    )).toBe('workspace-dirty-enabled');
    expect(getProjectBreakpointMarkerState(
      { ...breakpoint, enabled: false },
      revision,
      'checking',
    )).toBe('workspace-unknown-disabled');
  });

  it('binds breakpoints only when generated code matches the Artifact source', async () => {
    const builtCode = 'void setup() {}\\nvoid loop() {}\\n';
    const builtCodeSha256 = await sha256ProjectSource(builtCode);
    files.set(artifactPath, JSON.stringify({
      build: {
        source: {
          sha256: builtCodeSha256,
        },
      },
      files: [{
        role: 'source-map',
        path: 'block-source-map.json',
        sha256: revision,
      }],
    }));
    const service = new ProjectDebugConfigurationService();

    expect(service.refresh(projectPath).buildConsistency)
      .toBe('workspace-unknown');
    expect((await service.updateWorkspaceGeneratedCode(
      projectPath,
      builtCode,
    )).buildConsistency).toBe('current');
    expect(service.requireBindableSourceMapRevision(projectPath))
      .toBe(revision);

    expect(service.markWorkspaceDirty(projectPath).buildConsistency)
      .toBe('dirty');
    expect(() => service.requireBindableSourceMapRevision(projectPath))
      .toThrowError(/重新编译/);

    expect((await service.updateWorkspaceGeneratedCode(
      projectPath,
      `${builtCode}// changed\\n`,
    )).buildConsistency).toBe('dirty');
    expect((await service.updateWorkspaceGeneratedCode(
      projectPath,
      builtCode,
    )).buildConsistency).toBe('current');
  });

  it('refreshes the Artifact identity after a successful build', async () => {
    const firstCode = 'void setup() {}\\n';
    const nextCode = 'void setup() { pinMode(2, OUTPUT); }\\n';
    const nextRevision = 'd'.repeat(64);
    files.set(artifactPath, JSON.stringify({
      build: {
        source: {
          sha256: await sha256ProjectSource(firstCode),
        },
      },
      files: [{
        role: 'source-map',
        path: 'block-source-map.json',
        sha256: revision,
      }],
    }));
    const service = new ProjectDebugConfigurationService();
    await service.updateWorkspaceGeneratedCode(projectPath, firstCode);

    files.set(artifactPath, JSON.stringify({
      build: {
        source: {
          sha256: await sha256ProjectSource(nextCode),
        },
      },
      files: [{
        role: 'source-map',
        path: 'block-source-map.json',
        sha256: nextRevision,
      }],
    }));
    const state = await service.updateWorkspaceGeneratedCode(
      projectPath,
      nextCode,
      { refreshArtifact: true },
    );

    expect(state.sourceMapRevision).toBe(nextRevision);
    expect(state.buildConsistency).toBe('current');
  });

  it('derives build consistency from all three required identities', () => {
    expect(deriveProjectBuildConsistency('', artifactSourceSha256, revision))
      .toBe('artifact-unavailable');
    expect(deriveProjectBuildConsistency(revision, '', revision))
      .toBe('artifact-unavailable');
    expect(deriveProjectBuildConsistency(revision, artifactSourceSha256, ''))
      .toBe('workspace-unknown');
    expect(deriveProjectBuildConsistency(
      revision,
      artifactSourceSha256,
      artifactSourceSha256,
    )).toBe('current');
    expect(deriveProjectBuildConsistency(
      revision,
      artifactSourceSha256,
      'e'.repeat(64),
    )).toBe('dirty');
  });

  it('keeps an ephemeral selected debug target across editor teardown', () => {
    const service = new ProjectDebugConfigurationService();
    const selections: string[] = [];
    service.selectedDebugTarget$.subscribe(({ blockId }) => {
      selections.push(blockId);
    });

    service.rememberSelectedDebugTarget(projectPath, 'block-delay');
    service.refresh(projectPath);
    expect(service.getSelectedDebugTarget(projectPath)).toBe('block-delay');
    expect(selections).toEqual(['block-delay']);

    service.withoutSelectedDebugTargetCapture(() => {
      service.rememberSelectedDebugTarget(projectPath, 'block-current-frame');
    });
    expect(service.getSelectedDebugTarget(projectPath)).toBe('block-delay');
    expect(selections).toEqual(['block-delay']);

    service.rememberSelectedDebugTarget(projectPath, 'block-user-choice');
    expect(service.getSelectedDebugTarget(projectPath)).toBe(
      'block-user-choice',
    );
    expect(selections).toEqual(['block-delay', 'block-user-choice']);
    expect(service.getSelectedDebugTarget('C:/projects/other')).toBe('');
  });

  it('keeps the browser-only editor read-only without a local file bridge', () => {
    (window as any).fs = undefined;
    (window as any).path = undefined;
    const service = new ProjectDebugConfigurationService();

    const state = service.refresh(projectPath);

    expect(state.configuration.breakpoints).toEqual([]);
    expect(state.sourceMapRevision).toBe('');
    expect(state.buildConsistency).toBe('artifact-unavailable');
    expect(() => service.upsertBreakpoint(projectPath, {
      blockId: 'block-1',
      sourceMapRevision: revision,
      enabled: true,
    })).toThrowError(/桌面版/);
  });
});
