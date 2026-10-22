export interface CloudSyncBaseline {
  cloudId: string;
  accountId: string;
  apiBase: string;
  archiveSha256: string;
}

export function readCloudSyncBaseline(projectPath: string, cloudId: string, accountId: string, apiBase: string): string | null {
  try {
    const baseline: CloudSyncBaseline = JSON.parse(window['fs'].readFileSync(`${projectPath}/.aily/cloud-sync.json`, 'utf8'));
    return baseline.cloudId === String(cloudId) && baseline.accountId === accountId && baseline.apiBase === apiBase
      && /^[a-f0-9]{64}$/.test(baseline.archiveSha256) ? baseline.archiveSha256 : null;
  } catch { return null; }
}

export function writeCloudSyncBaseline(projectPath: string, baseline: CloudSyncBaseline): void {
  if (!/^[a-f0-9]{64}$/.test(baseline.archiveSha256)) throw new Error('云端未返回有效归档基线，请保留本地工程并重新打开云工程');
  window['fs'].mkdirSync(`${projectPath}/.aily`);
  window['fs'].writeFileSync(`${projectPath}/.aily/cloud-sync.json`, JSON.stringify(baseline));
}
