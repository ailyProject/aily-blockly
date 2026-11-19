import { sha256Hex } from '../../../utils/crypto.utils';
import { captureProjectDiskRecovery } from './project-disk-recovery';
import { inspectLegacyProjectRecovery } from './project-recovery-backup';
import { ProjectRecoveryRequests } from './project-recovery-request';

describe('project-local recovery backups and original request observations', () => {
  const project = '/private/current', abi = '{"pages":[{"id":"page-1"}]}';
  let previous: any, files: Map<string, string>, writes: string[];
  beforeEach(() => {
    previous = window['fs']; writes = [];
    files = new Map([[`${project}/package.json`, '{}'], [`${project}/project.abi`, abi],
      [`${project}/project.abs`, 'retained candidate'], [`${project}/project.abs.map.json`, '{}']]);
    window['fs'] = { projectSyncStorageVersion: 2, existsSync: file => files.has(file),
      readFileSync: file => files.get(file), writeFileSync: () => { throw new Error('No root archive or copy may be written'); },
      readDirSync: () => [...files.keys()].filter(file => file.startsWith(project + '/') && !file.slice(project.length + 1).includes('/'))
        .map(file => ({ name: file.slice(project.length + 1), _isFile: true })),
      openProjectSyncStorage: async (root, guard) => {
        expect(root).toBe(project);
        const locate = key => /^(project\.abi|project\.abs|project\.abs\.map\.json)$/.test(key)
          ? `${root}/${key}` : `${root}/.aily/abs-sync/${key}`;
        const read = async key => { guard(); return files.get(locate(key)) ?? null; };
        return { read, withLock: operation => new Promise((resolve, reject) => operation({ read,
          replace: async (key, expected, text) => {
            guard(); expect(key).toMatch(/^recoveries\//); expect(expected).toBeNull();
            if (files.has(locate(key))) return false;
            writes.push(locate(key)); files.set(locate(key), text); return true;
          } }, result => result.ok ? resolve(result.value) : reject(Object.assign(new Error(result.error.message), { code: result.error.code })))) };
      } } as any;
  });
  afterEach(() => window['fs'] = previous);

  it('keeps the complete primary and partial view inside append-only backup storage without another project', async () => {
    const capture = await captureProjectDiskRecovery(project, () => {}, { documentText: '{"partial":true}' });
    const first = await capture.publish(project), second = await capture.publish(project);
    expect(first.recoveryArchive).toMatch(/\/\.aily\/abs-sync\/recoveries\/source-[a-f0-9]{64}\.json$/);
    expect(second.recoveryArchive).toBe(first.recoveryArchive); expect(writes.length).toBe(1);
    expect(files.get(`${project}/project.abi`)).toBe(abi);
    expect(files.get(`${project}/project.abs`)).toBe('retained candidate');
    const backup = JSON.parse(files.get(first.recoveryArchive!)!);
    expect(backup.files['project.abi']).toBe(abi); expect(backup.partialCanvas.document).toEqual({ partial: true });
  });

  it('observes a completed recovery after the renderer is recreated without starting it again', async () => {
    const requestId = 'durable-recovery-request';
    const journal = new ProjectRecoveryRequests(project, () => {});
    expect(await journal.begin(requestId)).toBeTrue();
    const result = { ok: true, project, ready: true, candidateApplied: false, recoveryState: 'completed' };
    await journal.complete(requestId, result);
    const cold = new ProjectRecoveryRequests(project, () => {});
    expect(await cold.observe(requestId)).toEqual({ started: true, result });
    expect(await cold.begin(requestId)).toBeFalse(); expect(writes.length).toBe(2);
  });

  it('retains an interrupted request as unknown and never replays it or consumes an observation-only ID', async () => {
    const journal = new ProjectRecoveryRequests(project, () => {});
    expect(await journal.observe('not-started-request')).toEqual({ started: false }); expect(writes).toEqual([]);
    expect(await journal.begin('interrupted-request')).toBeTrue();
    const cold = new ProjectRecoveryRequests(project, () => {});
    expect(await cold.observe('interrupted-request')).toEqual({ started: true });
    expect(await cold.begin('interrupted-request')).toBeFalse(); expect(writes.length).toBe(1);
  });

  it('recognizes a valid old archive after later edits only as discovery facts, without restoring or granting writes', async () => {
    const oldAbi = '{"pages":[{"id":"old"}]}', archive = `${project}/recovery-source-12345678-1234-1234-1234-123456789abc.json`;
    files.set(archive, JSON.stringify({ version: 1, sourceProject: '/private/old-location', files: { 'project.abi': oldAbi },
      rawFiles: { 'project.abi': { encoding: 'utf8', bytes: new TextEncoder().encode(oldAbi).length,
        hash: `sha256:${await sha256Hex(oldAbi)}` } } }));
    const facts = await inspectLegacyProjectRecovery(project, () => {});
    expect(facts?.sourceProject).toBe('/private/old-location'); expect(facts?.authority).toBe('discovery-only');
    expect(files.get(`${project}/project.abi`)).toBe(abi); expect(writes).toEqual([]);
    files.set(archive, '{"version":1,"sourceProject":"forged","files":{"project.abi":"{}"},"rawFiles":{"project.abi":{"encoding":"utf8","bytes":2,"hash":"wrong"}}}');
    expect(await inspectLegacyProjectRecovery(project, () => {})).toBeNull();
  });

  it('requires current project authority and the native backup store, never falling back to a root archive', async () => {
    window['fs'].projectSyncStorageVersion = 1;
    const capture = await captureProjectDiskRecovery(project, () => {}, { notApplicable: true });
    await expectAsync(capture.publish(project)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RECOVERY_BACKUP_UNAVAILABLE' }));
    expect(writes).toEqual([]);
  });
});
