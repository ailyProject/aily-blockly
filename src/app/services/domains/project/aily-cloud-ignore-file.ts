export const AILY_CLOUD_IGNORE_FILE = '.ailyignore';

const DEFAULT_CLOUD_IGNORE = 'build/\n';

export function ensureAilyCloudIgnoreFile(projectPath: string): void {
  const fs = window['fs'];
  const ignorePath = window['path'].join(projectPath, AILY_CLOUD_IGNORE_FILE);
  if (!fs.existsSync(ignorePath)) {
    try {
      fs.writeFileSync(ignorePath, DEFAULT_CLOUD_IGNORE, { flag: 'wx' });
      return;
    } catch (error) {
      // The preload can drop error codes if another writer creates the file first.
      if (!fs.existsSync(ignorePath)) throw error;
    }
  }
  if (!fs.lstatSync(ignorePath)._isFile) throw new Error(`${AILY_CLOUD_IGNORE_FILE} 必须是普通文件：${ignorePath}`);
}
