import ignore from 'ignore';
import { AILY_CLOUD_IGNORE_FILE } from '@domain/project/public-api';

const excludedRootEntries = new Set([
  'node_modules', 'package-lock.json', 'project.7z', 'project.abi.backup', 'project.abs', 'project.abs.map.json',
]);
const excludedCoderDotFiles = new Set(['.git', '.aily', '.temp', '.build', '.cache', '.pio']);
const excludedCoderSketchEntries = /^sketch\/(?:preprocess|library-cache|build-config|upload-config|target-compile|compile-preprocess-.*)\.json$/;
const cloudIgnoreWriteTemporary = /^\.\.ailyignore\.[a-f0-9-]{36}\.tmp$/;

/** Project-relative 7-Zip entries. A trailing slash identifies an empty directory. */
export function listCloudProjectEntries(projectPath: string, category: 'blockly' | 'coder'): string[] {
  const fs = window['fs'], path = window['path'];
  const isCoder = category === 'coder';
  const isWindows = window['platform']?.isWindows === true;
  const files = fs.readDirSync(projectPath);
  const rules = ignore({ ignorecase: false });
  const ignoreFile = files.find(entry => entry.name === AILY_CLOUD_IGNORE_FILE);
  if (ignoreFile) {
    if (!ignoreFile._isFile) throw new Error(`${AILY_CLOUD_IGNORE_FILE} 必须是普通文件`);
    rules.add(fs.readFileSync(path.join(projectPath, AILY_CLOUD_IGNORE_FILE), 'utf8'));
  }

  const entries: string[] = [];
  function visit(children: typeof files, prefix: string): void {
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (!entry._isFile && !entry._isDirectory) continue;
      if (entry._isFile && !prefix && (name === AILY_CLOUD_IGNORE_FILE || name === 'package.json'
        || (!isCoder && name === 'project.abi'))) {
        entries.push(name);
        continue;
      }
      const systemName = isWindows ? entry.name.toLowerCase() : entry.name;
      const systemPath = isWindows ? name.toLowerCase() : name;
      if (!prefix && (excludedRootEntries.has(systemName) || cloudIgnoreWriteTemporary.test(systemName)
        || (isCoder && systemName === 'project.abi'))) continue;
      if (systemName.startsWith('.') && (!isCoder || entry._isDirectory
        || excludedCoderDotFiles.has(systemName) || systemName.startsWith('.env')
        || systemName === (isWindows ? '.ds_store' : '.DS_Store'))) continue;
      if (isCoder && excludedCoderSketchEntries.test(systemPath)) continue;

      const relative = entry._isDirectory ? `${name}/` : name;
      if (rules.ignores(relative)) continue;
      if (entry._isDirectory) {
        const contents = fs.readDirSync(path.join(projectPath, name));
        if (contents.length) visit(contents, relative);
        else entries.push(relative);
      } else entries.push(relative);
    }
  }
  visit(files, '');
  return entries;
}
