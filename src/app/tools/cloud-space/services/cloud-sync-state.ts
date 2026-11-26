export interface CloudSyncBinding {
  cloudId: string;
  archiveSha256: string;
}

export interface CloudSyncPending {
  requestId: string;
  archiveSha256: string;
  category: 'blockly' | 'coder';
  projectData: Record<string, unknown>;
  before: string;
}

export interface CloudSyncState {
  version: 1;
  identity: string;
  scope: string;
  binding?: CloudSyncBinding;
  pending?: CloudSyncPending;
}

export const archiveHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function projectCloudIdentity(projectPath: string): string {
  return JSON.stringify(window['fs'].captureProjectAttachment(projectPath));
}

export function readCloudSyncState(projectPath: string, identity: string, scope: string): CloudSyncState {
  const files = window['fs'];
  const directory = window['path'].join(projectPath, '.aily');
  const file = window['path'].join(directory, 'cloud-sync-state.json');
  if (files.existsSync(directory) && !files.lstatSync(directory)._isDirectory) throw new Error('云同步记录目录不可用');
  if (!files.existsSync(file)) return { version: 1, identity, scope };
  if (!files.lstatSync(file)._isFile) throw new Error('云同步记录文件不可用');
  const state = JSON.parse(files.readFileSync(file, 'utf8')) as CloudSyncState;
  if (state.version !== 1) throw new Error('云同步记录版本无法识别');
  if (state.identity !== identity) return { version: 1, identity, scope };
  if (state.scope !== scope) {
    if (state.pending) throw new Error('原同步仍待确认，请切换回发起同步的账号');
    return { version: 1, identity, scope };
  }
  if (state.binding && (!state.binding.cloudId || !archiveHash(state.binding.archiveSha256))) {
    throw new Error('云工程本地同步记录不完整，请重新下载云工程或另存新工程');
  }
  if (state.pending && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(state.pending.requestId)
    || !archiveHash(state.pending.archiveSha256) || typeof state.pending.before !== 'string'
    || !state.pending.projectData || typeof state.pending.projectData !== 'object'
    || !['coder', 'blockly'].includes(state.pending.category))) {
    throw new Error('云工程原同步请求记录不完整，请核对云空间后再操作');
  }
  return state;
}

export function writeCloudSyncState(projectPath: string, state: CloudSyncState): void {
  if (projectCloudIdentity(projectPath) !== state.identity) throw new Error('同步来源目录已被移动或替换');
  const files = window['fs'];
  const directory = window['path'].join(projectPath, '.aily');
  if (!files.existsSync(directory)) files.mkdirSync(directory, { recursive: true });
  if (!files.lstatSync(directory)._isDirectory) throw new Error('云同步记录目录不可用');
  const file = window['path'].join(directory, 'cloud-sync-state.json');
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  files.writeFileSync(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  try {
    if (projectCloudIdentity(projectPath) !== state.identity) throw new Error('同步来源目录已被移动或替换');
    files.renameSync(temp, file);
  } finally {
    try {
      if (projectCloudIdentity(projectPath) === state.identity && files.lstatSync(directory)._isDirectory
        && files.existsSync(temp)) files.unlinkSync(temp);
    } catch { /* The recorded project is no longer available for cleanup. */ }
  }
}

export async function readLocalCloudArchive(path: string): Promise<{ contents: ArrayBuffer; sha256: string }> {
  const contents = await window['fs'].readFileBufferAsync(path) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', contents);
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { contents, sha256 };
}

// Local metadata travels only with the originating directory. A changed source
// is reported separately from success of the archive that the server accepted.
export function cloudSourceStamp(projectPath: string, category: 'blockly' | 'coder'): string {
  const fs = window['fs'], path = window['path'];
  const files: Array<[string, number, string]> = [];
  const excluded = new Set(['node_modules', 'project.7z', 'package-lock.json', 'project.abi.backup',
    'project.abs', 'project.abs.map.json', ...(category === 'coder' ? ['project.abi'] : [])]);
  function visit(dir: string, relative: string): void {
    for (const entry of fs.readDirSync(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || (entry.name.startsWith('.') && (entry._isDirectory || category === 'blockly'))) continue;
      const absolute = path.join(dir, entry.name), name = relative + entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat._isDirectory) visit(absolute, name + '/');
      if (stat._isFile) files.push([name, stat.size, stat.mtime]);
    }
  }
  visit(projectPath, '');
  return JSON.stringify(files);
}
