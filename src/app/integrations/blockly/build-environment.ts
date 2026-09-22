/** Read-only projection of the effective dependencies used by child/scripts/preprocess.js. */
export interface BuildEnvironmentInput {
  project: string;
  appDataPath: string;
  boardModule: string;
  board: Record<string, any>;
  dependencies: Record<string, string>;
  packageJson: Record<string, any>;
  coder: boolean;
}

export interface BuildEnvironmentPaths {
  join(...segments: string[]): string;
  exists(path: string): boolean;
}

export function describeBuildEnvironment(input: BuildEnvironmentInput, paths: BuildEnvironmentPaths) {
  const artifacts = Object.entries(input.dependencies).flatMap(([name, version]) => {
    const match = /^@aily-project\/(sdk|compiler|tool)-([A-Za-z0-9_.-]+)$/.exec(name);
    if (!match) return [];
    const kind = match[1];
    // Dependency ranges are not resolved install versions; never invent an installed path for them.
    const resolved = typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version);
    const basename = kind === 'tool' && match[2].startsWith('idf_') ? 'esp32-arduino-libs' : match[2];
    const root = resolved ? paths.join(input.appDataPath, kind === 'tool' ? 'tools' : kind,
      `${basename}${kind === 'sdk' ? '_' : '@'}${version}`) : null;
    return [{ package: name, version, kind, root, installed: !!root && paths.exists(root) }];
  });
  const sketch = input.coder ? null : paths.join(input.project, '.temp', 'sketch', 'sketch.ino');
  const macros = input.packageJson['macros'] ?? input.packageJson['MACROS'] ?? input.packageJson['projectConfig']?.macros ?? [];
  return {
    version: 1,
    source: 'effective-board-dependencies',
    status: artifacts.some(item => item.kind === 'sdk' && item.installed) ? 'available' : 'unavailable',
    boardModule: input.boardModule,
    core: input.board['core'] ?? null,
    target: /(?:^|\s)(?:-b|--board)\s+(\S+)/.exec(input.board['compilerParam'] ?? '')?.[1] ?? null,
    artifacts,
    searchRoots: [...new Set(artifacts.filter(item => item.installed && item.kind !== 'compiler').map(item => item.root!))],
    macros,
    generatedSketch: sketch ? { path: sketch, exists: paths.exists(sketch), readOnly: true } : null,
    targetCompileContext: {
      path: paths.join(input.project, input.coder ? 'sketch' : '.temp', 'target-compile.json'),
      readOnly: true,
      note: 'Produced by project_build preprocessing. The C++ test template verifies configuration hashes before use; do not hand-copy compiler flags.',
    },
    note: 'Paths describe the current build selection, not API compatibility or successful compilation. Search only the relevant installed roots for public headers/examples. Missing artifacts require dependency repair; do not guess another SDK version.',
  };
}
