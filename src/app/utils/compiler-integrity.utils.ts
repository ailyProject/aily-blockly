/** Bounded metadata checks: no recursive walk, binary hashing or compiler process. */
const GCC_TARGETS: Record<string, readonly string[]> = {
  'esp-x32': ['xtensa-esp-elf', 'xtensa-esp32-elf', 'xtensa-esp32s2-elf', 'xtensa-esp32s3-elf'],
  'esp-rv32': ['riscv32-esp-elf'],
  'avr-gcc': ['avr'],
  'xtensa-lx106-elf-gcc': ['xtensa-lx106-elf'],
  'xtensa-esp32s3-elf-gcc': ['xtensa-esp32s3-elf'],
  'arm-none-eabi-gcc': ['arm-none-eabi'],
  'gcc-arm-none-eabi': ['arm-none-eabi'],
  'xpack-arm-none-eabi-gcc': ['arm-none-eabi'],
  'pqt-gcc': ['arm-none-eabi'],
  'riscv-gcc': ['riscv-nuclei-elf'],
};

export interface CompilerFileSystem {
  statSync(path: string): { size: number; _isFile: boolean; mode?: number };
  readDirSync(path: string): Array<string | { name: string }>;
}

/** Undefined means this package has no registered GCC layout; retain its existing readiness policy. */
export function findCompilerIntegrityProblem(
  packageName: string,
  directory: string,
  fs: CompilerFileSystem,
  join: (...parts: string[]) => string,
  windows: boolean,
): string | undefined {
  const targets = GCC_TARGETS[packageName.replace(/^@aily-project\/compiler-/, '')];
  if (!targets) return undefined;
  const suffix = windows ? '.exe' : '';
  // Electron contextBridge preserves Error.message but drops custom Error.code.
  const absent = (error: any): boolean => ['ENOENT', 'ENOTDIR'].includes(error?.code)
    || /^(?:ENOENT|ENOTDIR):/.test(String(error?.message || ''));
  const validFile = (filename: string): boolean => {
    try {
      const stat = fs.statSync(filename);
      return stat._isFile && stat.size > 0 && (windows || stat.mode === undefined || (stat.mode & 0o111) !== 0);
    } catch (error: any) {
      if (absent(error)) return false;
      // Access failures are not evidence of corruption and must not trigger deletion.
      throw error;
    }
  };
  for (const target of targets) {
    for (const tool of ['gcc', 'g++', 'ar', 'as', 'ld', 'objcopy', 'size']) {
      const filename = join(directory, 'bin', `${target}-${tool}${suffix}`);
      if (!validFile(filename)) return filename;
    }
  }
  // ESP32's chip-specific commands are wrappers around the first target.
  // Older ARM distributions keep these programs in lib/gcc instead of libexec/gcc.
  const roots = ['libexec', 'lib'].map(base => join(directory, base, 'gcc', targets[0]));
  for (const root of roots) {
    let versions: string[];
    try {
      versions = fs.readDirSync(root).map(entry => typeof entry === 'string' ? entry : entry.name);
    } catch (error: any) {
      if (absent(error)) continue;
      throw error;
    }
    if (versions.some(version => /^\d/.test(version)
        && ['cc1', 'cc1plus', 'collect2'].every(tool => validFile(join(root, version, tool + suffix))))) {
      return undefined;
    }
  }
  return roots[0];
}
