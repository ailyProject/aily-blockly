export interface ProjectProgramPublicationHost {
  readonly projectProgramPublicationVersion?: number;
  readonly nativeSaveReceiptVersion?: number;
  readonly projectSyncStorageVersion?: number;
  openProjectSyncStorage?: (...args: any[]) => unknown;
}

/** The matching host enables the complete program writer cohort. Read-only
 * inspection and ordinary files do not acquire a publication capability. */
export function requireProjectProgramPublication(
  host: ProjectProgramPublicationHost | undefined = window['fs'],
): void {
  if (host?.projectProgramPublicationVersion !== 1 || host.nativeSaveReceiptVersion !== 2
    || host.projectSyncStorageVersion !== 2 || typeof host.openProjectSyncStorage !== 'function') {
    throw Object.assign(new Error('当前项目发布服务不完整；项目和未保存修改已保留。'),
      { code: 'PROJECT_PROGRAM_HOST_UPDATE_REQUIRED' });
  }
}
