import type { AbsSyncStorageAccess, AbsSyncStoragePort } from './abs-baseline-store';
import { AbsCandidateJournal } from './abs-candidate-journal';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { AbsSyncError } from './abs-state';
import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

class CandidateMemoryPort implements AbsSyncStoragePort {
  files = new Map<string, string>([['project.abi', 'original primary'], ['project.abs', 'canonical source'], ['committed.json', 'original pointer']]);
  writes: string[] = [];
  async read(key: string) { return this.files.get(key) ?? null; }
  withLock<T>(operation: (storage: AbsSyncStorageAccess) => Promise<T>): Promise<T> {
    return operation({ read: key => this.read(key), replace: async (key, expected, text) => {
      expect(key).toMatch(/^recoveries\/candidate-[a-f0-9]{64}\.json$/); expect(expected).toBeNull();
      if (this.files.has(key)) return false;
      this.writes.push(key); this.files.set(key, text!); return true;
    } });
  }
}

describe('unapplied candidate backups inside the current project', () => {
  const project = '/private/current', source = 'broken(\n"完整候选🌟"';
  let previous: any, port: CandidateMemoryPort;
  beforeEach(() => {
    previous = window['fs']; port = new CandidateMemoryPort();
    window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: async (path, guard) => {
      expect(path).toBe(project);
      return { read: key => { guard(); return port.read(key); },
        withLock: operation => new Promise((resolve, reject) => {
          void port.withLock(async storage => new Promise<void>(settled => operation(storage, result => {
            settled(); if (result.ok) resolve(result.value); else reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
          })));
        }) };
    } } as any;
  });
  afterEach(() => window['fs'] = previous);
  const input = async (value = source) => ({ hash: await hashAbsText(value), bytes: new TextEncoder().encode(value).byteLength,
    intentGeneration: 'original-intent', sourceEdits: [[{ start: 0, end: 0, text: 'broken' }]] });

  it('preserves syntactically invalid source and its original origin, deduplicating repeated requests without baseline changes', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), before = [...port.files];
    const first = await journal.preserve(source, await input()), second = await journal.preserve(source, await input());
    expect(first).toEqual(second); expect(first.candidateApplied).toBeFalse(); expect(port.writes.length).toBe(1);
    expect(first.path).toBe(`${project}/.aily/abs-sync/recoveries/candidate-${first.recordHash.slice(7)}.json`);
    expect((await new AbsCandidateJournal(port, project, () => {}).read(first.recordHash)).candidate)
      .toEqual({ source, intentGeneration: 'original-intent', sourceEdits: [[{ start: 0, end: 0, text: 'broken' }]] });
    for (const [key, value] of before) expect(port.files.get(key)).toBe(value);
  });

  it('keeps an empty or unknown-origin candidate without manufacturing a generation or apply permission', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {});
    const archive = await journal.preserve('', { hash: await hashAbsText(''), bytes: 0 });
    const read = await journal.read(archive.recordHash);
    expect(read.candidate).toEqual({ source: '' }); expect(read.candidateArchive.candidateApplied).toBeFalse();
    expect((read as any).generation).toBeUndefined(); expect((read as any).authority).toBeUndefined();
  });

  it('archives opaque SDK edit proof without treating it as generation or apply authority', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), metadata = await input();
    const proof = { version: 2, key: `${project}/project.abs`, identity: 'original-view:inode', hash: metadata.hash,
      mapHash: '0'.repeat(64), origin: { version: 1, sourceKey: `${project}/project.abs`, rootIdentity: 'device:inode',
        mapHash: '1'.repeat(64), generation: metadata.intentGeneration, baseAbsHash: 'sha256:' + '2'.repeat(64) },
      steps: [{ before: 'sha256:' + '2'.repeat(64), after: metadata.hash, edits: metadata.sourceEdits[0] }] };
    const first = await journal.preserve(source, { ...metadata, editProof: proof });
    expect(await journal.preserve(source, { ...metadata, editProof: proof })).toEqual(first);
    const read = await new AbsCandidateJournal(port, project, () => {}).read(first.recordHash);
    expect(read.candidate.editProof).toEqual(proof); expect(read.candidate.intentGeneration).toBe(metadata.intentGeneration);
    expect(read.candidateArchive.candidateApplied).toBeFalse(); expect((read as any).evidence).toBeUndefined();
    proof.identity = 'other-inode';
    expect((read.candidate.editProof as any).identity).toBe('original-view:inode');
    const other = await journal.preserve(source, { ...metadata, editProof: proof });
    expect(other.recordHash).not.toBe(first.recordHash); expect(other.hash).toBe(first.hash);
    expect(port.files.get('project.abi')).toBe('original primary'); expect(port.files.get('committed.json')).toBe('original pointer');
  });

  it('keeps the full candidate when optional edit proof is oversized or cannot be represented as JSON', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), metadata = await input();
    const original = await journal.preserve(source, metadata), cycle: any = {}; cycle.self = cycle;
    for (const editProof of [{ payload: '原'.repeat(180000) }, { value: BigInt(1) }, cycle, undefined]) {
      expect(await journal.preserve(source, { ...metadata, editProof })).toEqual(original);
    }
    const read = await journal.read(original.recordHash);
    expect(read.candidate.source).toBe(source); expect(read.candidate.editProof).toBeUndefined();
    expect(port.writes.length).toBe(1);
  });

  it('binds opaque proof to the complete record hash and retains legacy records without proof', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), metadata = await input();
    const old = await journal.preserve(source, metadata), current = await journal.preserve(source, { ...metadata, editProof: { opaque: 'retained' } });
    expect((await journal.read(old.recordHash)).candidate.editProof).toBeUndefined();
    const key = `recoveries/candidate-${current.recordHash.slice(7)}.json`, record = JSON.parse(port.files.get(key)!);
    record.candidate.editProof.opaque = 'tampered'; port.files.set(key, absJson(record));
    await expectAsync(journal.read(current.recordHash))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_UNAVAILABLE' }));
  });

  it('rejects invalid metadata, oversized declarations, changed source and caller-supplied archive paths before writing', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), valid = await input();
    for (const value of [{ ...valid, hash: 'sha256:' + '0'.repeat(64) }, { ...valid, bytes: valid.bytes + 1 },
      { ...valid, bytes: 64 * 1024 * 1024 + 1 }, { ...valid, path: '/foreign/archive' },
      { ...valid, sourceEdits: [[{ start: -1, end: 0, text: 'x' }]] }]) {
      await expectAsync(journal.preserve(source, value as any)).toBeRejected();
    }
    await expectAsync(journal.read('../../foreign.json')).toBeRejected(); expect(port.writes).toEqual([]);
  });

  it('checks record hashes, candidate hashes and project identity when restoring cache data', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), archive = await journal.preserve(source, await input());
    const key = `recoveries/candidate-${archive.recordHash.slice(7)}.json`, original = port.files.get(key)!;
    port.files.set(key, original + ' '); await expectAsync(journal.read(archive.recordHash)).toBeRejected();
    const foreign = absJson({ ...JSON.parse(original), project: '/foreign' }), foreignHash = await hashAbsText(foreign);
    port.files.set(`recoveries/candidate-${foreignHash.slice(7)}.json`, foreign);
    await expectAsync(journal.read(foreignHash)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_INVALID' }));
    const forged = JSON.parse(original); forged.candidate.source = 'changed source';
    const text = absJson(forged), hash = await hashAbsText(text); port.files.set(`recoveries/candidate-${hash.slice(7)}.json`, text);
    await expectAsync(journal.read(hash)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_INVALID' }));
  });
  it('can preserve known complete cache bytes again after a missing backup without changing any current source', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), metadata = await input();
    const archive = await journal.preserve(source, metadata), key = `recoveries/candidate-${archive.recordHash.slice(7)}.json`;
    port.files.delete(key); const before = [...port.files];
    await expectAsync(new AbsCandidateJournal(port, project, () => {}).read(archive.recordHash))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_UNAVAILABLE' }));
    expect(await journal.preserve(source, metadata)).toEqual(archive);
    expect((await new AbsCandidateJournal(port, project, () => {}).read(archive.recordHash)).candidate.source).toBe(source);
    for (const [name, value] of before) expect(port.files.get(name)).toBe(value);
  });

  it('preserves known complete cache bytes in a fresh archive while retaining a damaged old backup', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), metadata = await input();
    const archive = await journal.preserve(source, metadata), key = `recoveries/candidate-${archive.recordHash.slice(7)}.json`;
    const damaged = port.files.get(key)! + ' damaged'; port.files.set(key, damaged);
    const before = [...port.files], replacement = await journal.preserve(source, metadata);
    expect(replacement.recordHash).not.toBe(archive.recordHash); expect(replacement.hash).toBe(archive.hash);
    expect(await journal.preserve(source, metadata)).toEqual(replacement);
    expect((await new AbsCandidateJournal(port, project, () => {}).read(replacement.recordHash)).candidate)
      .toEqual({ source, intentGeneration: metadata.intentGeneration, sourceEdits: metadata.sourceEdits });
    for (const [name, value] of before) expect(port.files.get(name)).toBe(value);
    await expectAsync(journal.read(archive.recordHash))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_UNAVAILABLE' }));
  });
  it('can retain repeated damage without a depth gate and reads the healthy archive independently from old records', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), metadata = await input();
    let archive = await journal.preserve(source, metadata);
    const damagedKeys: string[] = [];
    for (let index = 0; index < 70; index++) {
      const key = `recoveries/candidate-${archive.recordHash.slice(7)}.json`;
      port.files.set(key, `damaged original ${index}`); damagedKeys.push(key);
      archive = await journal.preserve(source, metadata);
    }
    expect(await journal.preserve(source, metadata)).toEqual(archive);
    expect(damagedKeys.every((key, index) => port.files.get(key) === `damaged original ${index}`)).toBeTrue();
    const text = port.files.get(`recoveries/candidate-${archive.recordHash.slice(7)}.json`)!;
    expect(Object.keys(JSON.parse(text).damagedPredecessor).sort()).toEqual(['hash', 'recordHash']);
    damagedKeys.forEach(key => port.files.delete(key));
    expect((await new AbsCandidateJournal(port, project, () => {}).read(archive.recordHash)).candidate.source).toBe(source);
  });

  it('rejects malformed damaged-record observations even when the new full record hash matches', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), archive = await journal.preserve(source, await input());
    const original = JSON.parse(port.files.get(`recoveries/candidate-${archive.recordHash.slice(7)}.json`)!);
    for (const damagedPredecessor of [null, { recordHash: archive.recordHash, hash: 'invalid' },
      { recordHash: archive.recordHash, hash: archive.hash, path: '/other/project' }]) {
      const text = absJson({ ...original, damagedPredecessor }), hash = await hashAbsText(text);
      port.files.set(`recoveries/candidate-${hash.slice(7)}.json`, text);
      await expectAsync(journal.read(hash))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_INVALID' }));
    }
  });

  it('does not overwrite a competing publication while replacing a damaged archive with known complete bytes', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), metadata = await input();
    const archive = await journal.preserve(source, metadata), oldKey = `recoveries/candidate-${archive.recordHash.slice(7)}.json`;
    port.files.set(oldKey, 'retained damage');
    let competingKey: string | undefined;
    const raced: AbsSyncStoragePort = { read: key => port.read(key), withLock: operation => port.withLock(storage => operation({
      read: key => storage.read(key), replace: async key => {
        competingKey = key; port.files.set(key, 'new external bytes'); return false;
      },
    })) };
    await expectAsync(new AbsCandidateJournal(raced, project, () => {}).preserve(source, metadata))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_CONFLICT' }));
    expect(port.files.get(oldKey)).toBe('retained damage'); expect(port.files.get(competingKey!)).toBe('new external bytes');
    expect(port.files.get('project.abi')).toBe('original primary'); expect(port.files.get('project.abs')).toBe('canonical source');
  });
  for (const code of ['ABS_STORAGE_ENCODING_INVALID', 'PROJECT_FILE_TOO_LARGE']) {
    it(`can back up verified complete cache data while retaining an old record with host read failure ${code}`, async () => {
      const metadata = await input(), archive = await new AbsCandidateJournal(port, project, () => {}).preserve(source, metadata);
      const key = `recoveries/candidate-${archive.recordHash.slice(7)}.json`, original = port.files.get(key)!;
      const unreadable: AbsSyncStoragePort = { read: name => port.read(name), withLock: operation => port.withLock(storage => operation({
        replace: (...args) => storage.replace(...args), read: async name => {
          if (name === key) throw Object.assign(new Error('Native bounded UTF-8 read refused this record'), { code });
          return storage.read(name);
        },
      })) };
      const journal = new AbsCandidateJournal(unreadable, project, () => {}), replacement = await journal.preserve(source, metadata);
      expect(replacement.recordHash).not.toBe(archive.recordHash);
      expect(await journal.preserve(source, metadata)).toEqual(replacement); expect(port.files.get(key)).toBe(original);
      const text = port.files.get(`recoveries/candidate-${replacement.recordHash.slice(7)}.json`)!;
      expect(JSON.parse(text).damagedPredecessor).toEqual({ recordHash: archive.recordHash, readFailure: code });
      expect((await journal.read(replacement.recordHash)).candidate.source).toBe(source);
    });
  }
  for (const code of ['EACCES', 'PROJECT_FILE_UNSAFE_PATH', 'ABS_CONTEXT_STALE', 'EIO']) {
    it(`keeps unrelated host read failure ${code} fatal rather than bypassing ownership or access checks`, async () => {
      const failure = Object.assign(new Error('Native read failed'), { code });
      const unreadable: AbsSyncStoragePort = { read: name => port.read(name), withLock: operation => port.withLock(storage => operation({
        replace: (...args) => storage.replace(...args), read: async () => { throw failure; },
      })) };
      const before = [...port.files];
      await expectAsync(new AbsCandidateJournal(unreadable, project, () => {}).preserve(source, await input())).toBeRejectedWith(failure);
      expect([...port.files]).toEqual(before); expect(port.writes).toEqual([]);
    });
  }

  it('backs up the candidate before runtime preparation fails and returns its reference without validating or applying', async () => {
    const validate = jasmine.createSpy('validate').and.throwError('must not validate');
    const tools = new AbsGenerationToolsService({ validateGeneration: validate, describeNativeCandidateFailure: async () => null } as any);
    const hash = 'sha256:' + 'a'.repeat(64), candidate = await input();
    const result: any = await tools.execute('abs_validate', { version: 2, requestId: crypto.randomUUID(),
      base: { generation: 'original-intent', scope: { projectKey: project, pageId: 'main' }, abiHash: hash, absHash: hash, mapHash: hash },
      candidate: { hash: candidate.hash, bytes: candidate.bytes } }, source, undefined, undefined, project,
      { project, assertCurrent: () => {}, prepareRuntime: async () => {
        expect(port.writes.length).toBe(1); throw new AbsSyncError('ABS_RUNTIME_NOT_READY', 'runtime failed');
      } });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_RUNTIME_NOT_READY'); expect(validate).not.toHaveBeenCalled();
    expect((await new AbsCandidateJournal(port, project, () => {}).read(result.candidateArchive.recordHash)).candidate.source).toBe(source);
    expect(port.files.get('project.abi')).toBe('original primary'); expect(port.files.get('committed.json')).toBe('original pointer');
  });

  it('preserves before a native validation failure and carries the archive on both failed and successful preparation', async () => {
    const candidate = await input(), hash = 'sha256:' + 'a'.repeat(64);
    const request = { version: 2, requestId: crypto.randomUUID(), base: { generation: 'original-intent',
      scope: { projectKey: project, pageId: 'main' }, abiHash: hash, absHash: hash, mapHash: hash },
      candidate: { hash: candidate.hash, bytes: candidate.bytes } };
    const validate = jasmine.createSpy('validate').and.callFake(async () => {
      expect(port.writes.length).toBe(1); throw new AbsSyncError('ABS_NATIVE_TIMEOUT', 'native failed');
    });
    const tools = new AbsGenerationToolsService({ validateGeneration: validate, describeNativeCandidateFailure: async () => null } as any);
    const failed: any = await tools.execute('abs_validate', request, source, undefined, undefined, project, { project, assertCurrent: () => {} });
    expect(failed.ok).toBeFalse(); expect(failed.candidateArchive.hash).toBe(candidate.hash);
    validate.and.resolveTo({ base: request.base, candidate: request.candidate });
    const success: any = await tools.execute('abs_validate', request, source, undefined, undefined, project, { project, assertCurrent: () => {} });
    expect(success.ok).toBeTrue(); expect(success.candidateArchive).toEqual(failed.candidateArchive); expect(port.writes.length).toBe(1);
  });

  it('archives a transferred overlay before editor readiness and can read it after cache loss without a file read', async () => {
    const tools = new AbsGenerationToolsService({} as any), bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = { currentProjectPath: project }; bridge.absGenerationTools = tools;
    bridge.absApplyInProgress = true; bridge.boardSwitchInProgress = true;
    bridge.aiOperations = { setActive: () => { throw new Error('No generic document mutation mask'); } };
    bridge.electronService = { readFile: jasmine.createSpy('transfer').and.returnValue(source) };
    const preserve = await bridge.execute({ operation: 'abs_recovery', path: project, params: {
      version: 2, requestId: crypto.randomUUID(), action: 'preserve_candidate', absPath: '/transfers/overlay.abs', candidate: await input() } });
    expect(preserve.ok).toBeTrue(); expect(preserve.receipt.action).toBe('preserve_candidate');
    const read = await bridge.execute({ operation: 'abs_recovery', path: project, params: {
      version: 2, requestId: crypto.randomUUID(), action: 'read_candidate', recordHash: preserve.candidateArchive.recordHash } });
    expect(read.ok).toBeTrue(); expect(read.candidate.source).toBe(source); expect(read.receipt.action).toBe('read_candidate');
    expect(bridge.electronService.readFile).toHaveBeenCalledOnceWith('/transfers/overlay.abs');
    expect(port.files.get('project.abs')).toBe('canonical source');
  });

  it('preserves the existing managed-dependency diagnosis and route after backing up a candidate', async () => {
    const candidate = await input(), hash = 'sha256:' + 'a'.repeat(64);
    const request = { version: 2, requestId: crypto.randomUUID(), base: { generation: 'original-intent',
      scope: { projectKey: project, pageId: 'main' }, abiHash: hash, absHash: hash, mapHash: hash },
      candidate: { hash: candidate.hash, bytes: candidate.bytes } };
    const dependencyConflict = { version: 1, status: 'available', sourceFilesChanged: false, project, token: hash,
      requestId: crypto.randomUUID(), entries: [{ field: 'dependencies', name: '@aily-project/lib-test', base: '1', staged: '2', disk: '3' }] };
    const failure = Object.assign(new Error('retained dependency versions'), { code: 'LIBRARY_DEPENDENCY_CONFLICT', dependencyConflict });
    const tools = new AbsGenerationToolsService({} as any), bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.ngZone = { run: operation => operation() };
    bridge.execute = () => tools.execute('abs_validate', request, source, undefined, undefined, project,
      { project, assertCurrent: () => {}, prepareRuntime: async () => { throw failure; } });
    const send = jasmine.createSpy('send');
    await bridge.handleIpcPayload({ send }, { requestId: 'outer-request', path: project, operation: 'abs_validate', params: request });
    const response = send.calls.mostRecent().args[1];
    expect(response.code).toBe('LIBRARY_DEPENDENCY_CONFLICT');
    expect(response.nextAction).toEqual({ tool: 'project_recover', input: { project, action: 'inspect_dependencies' } });
    expect(response.candidateArchive.hash).toBe(candidate.hash); expect(port.writes.length).toBe(1);
    expect(port.files.get('project.abi')).toBe('original primary');
  });
});
