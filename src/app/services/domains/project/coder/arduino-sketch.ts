/** Arduino sources stay in their original directory; Coder caches stay in sketch/. */
export function coderSourceDirectory(manifest: { arduinoSketch?: unknown }): string {
  return manifest?.arduinoSketch === true ? '.' : 'sketch';
}

export function normalizeProjectOpenPath(value: string): string {
  if (!value || !window['fs']?.existsSync(value)) return value;
  if (/\.(ino|aci|abi)$/i.test(value) && window['fs'].statSync(value)._isFile) {
    return window['path'].dirname(value);
  }
  return value;
}

/** Prefer the folder-named tab, never silently choose among unrelated sketches. */
export function findArduinoSketchEntry(root: string): string | null {
  try {
    const entries = window['fs'].readDirSync(root)
      .filter((entry: any) => entry._isFile && /\.ino$/i.test(entry.name))
      .map((entry: any) => entry.name as string);
    const name = window['path'].basename(root);
    return entries.find((entry: string) => entry.toLowerCase() === `${name}.ino`.toLowerCase())
      || (entries.length === 1 ? entries[0] : null);
  } catch { return null; }
}

/** Called only after the mode guard and project lock; never rewrites source files. */
export function prepareArduinoSketchProject(root: string): void {
  const fs = window['fs'];
  const path = window['path'];
  const packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) return;
  const entry = findArduinoSketchEntry(root);
  if (!entry) throw new Error('未找到 Arduino 主文件，请打开包含同名 .ino 文件的工程文件夹。');
  const nickname = path.basename(root);
  fs.writeFileSync(packagePath, JSON.stringify({
    name: nickname.toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'arduino-sketch',
    nickname,
    version: '1.0.0',
    private: true,
    type: 'coder',
    arduinoSketch: true,
    entry,
    framework: 'arduino',
    devmode: 'arduino',
    sourceRoots: ['.', 'src', 'sketch/libraries'],
    dependencies: {},
    boardDependencies: {},
    projectConfig: {},
  }, null, 2) + '\n');
}
