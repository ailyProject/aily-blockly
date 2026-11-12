import { isAilyLibraryPackageName } from '@shared/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';

export interface ManagedLibraryEnvironmentReference { requestId: string; originalTargetPid: number }
export interface ManagedLibraryScope { packages: readonly string[]; removedPackages: readonly string[] }

const failure = (message: string): never => { throw Object.assign(new Error(message), { code: 'LIBRARY_ENVIRONMENT_RUNTIME_UNVERIFIED' }); };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const packageName = (spec: string) => { const separator = spec.indexOf('@', 1); return separator < 0 ? spec : spec.slice(0, separator); };
const sameNames = (left: readonly string[], right: readonly string[]) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
const inputFiles = { package: 'package.json', lock: 'package-lock.json', npmrc: '.npmrc', shrinkwrap: 'npm-shrinkwrap.json', yarn: 'yarn.lock' };

export function readManagedLibraryEnvironmentReference(value: unknown): ManagedLibraryEnvironmentReference {
  if (!record(value) || Object.keys(value).some(key => !['requestId', 'originalTargetPid'].includes(key))
    || typeof value['requestId'] !== 'string' || !/^env1-[A-Za-z0-9][A-Za-z0-9._:-]{0,122}$/.test(value['requestId'])
    || !Number.isSafeInteger(value['originalTargetPid']) || value['originalTargetPid'] <= 0) {
    return failure('Runtime refresh requires the original managed environment request and Main process.');
  }
  return { requestId: value['requestId'], originalTargetPid: value['originalTargetPid'] };
}

/** Read the original Main journal, never the latest convenience status. This
 * grants runtime refresh only; it neither reconciles npm nor publishes Program. */
export async function readManagedLibraryEnvironment(project: string, value: unknown,
  scope: ManagedLibraryScope, assertCurrent: () => void): Promise<Record<string, any>> {
  const reference = readManagedLibraryEnvironmentReference(value);
  const names = scope.packages.map(packageName), removed = scope.removedPackages.map(packageName);
  if (!names.length || !names.every(isAilyLibraryPackageName) || !removed.every(isAilyLibraryPackageName)
    || removed.length && !sameNames(names, removed)) return failure('The managed library mutation scope changed.');
  assertCurrent();
  const storage = await window['fs'].openProjectSyncStorage(project, assertCurrent);
  assertCurrent();
  const response = await window['libraryDependencies'].observeEnvironment(project, { requestId: reference.requestId });
  assertCurrent();
  const environment = response?.environment, attachment = environment?.attachment, actual = storage?.attachment;
  if (!record(environment) || environment['version'] !== 1 || environment['requestId'] !== reference.requestId
    || environment['status'] !== 'completed' || environment['current'] !== true || environment['candidateApplied'] !== false
    || typeof environment['project'] !== 'string' || normalize(environment['project']) !== normalize(project)
    || !record(attachment) || !record(actual) || attachment['version'] !== 1 || actual['version'] !== 1
    || typeof attachment['root'] !== 'string' || typeof actual['root'] !== 'string'
    || normalize(attachment['root']) !== normalize(actual['root']) || normalize(actual['root']) !== normalize(project)
    || !['dev', 'ino', 'birthtimeNs'].every(key => typeof attachment['identity']?.[key] === 'string'
      && /^\d+$/.test(attachment['identity'][key]) && attachment['identity'][key] === actual['identity']?.[key])
    || environment['executor']?.version !== 1 || environment['executor']?.hostPid !== reference.originalTargetPid
    || !Number.isSafeInteger(environment['executor']?.storagePid) || environment['executor'].storagePid <= 0
    || typeof environment['executor']?.instanceId !== 'string' || !environment['executor'].instanceId
    || !Number.isSafeInteger(storage?.executor?.hostPid) || storage.executor.hostPid <= 0
    || environment['observer']?.version !== 1 || environment['observer']?.hostPid !== storage.executor.hostPid
    || environment['mutation']?.action !== (removed.length ? 'remove' : 'install')
    || !Array.isArray(environment['mutation']?.packages) || !environment['mutation'].packages.every(isAilyLibraryPackageName)
    || !sameNames(names, environment['mutation'].packages)) return failure('The original managed environment is not the current matching completed library mutation.');

  const hashes = environment['hashes'];
  if (!record(hashes) || Object.keys(hashes).length !== Object.keys(inputFiles).length) return failure('The completed environment has no exact input hashes.');
  let manifest: Record<string, any> | undefined;
  for (const [key, file] of Object.entries(inputFiles)) {
    assertCurrent();
    const text: string | null = await storage.read(file);
    assertCurrent();
    if ((text === null ? null : `sha256:${await sha256Hex(text)}`) !== hashes[key]) return failure('Environment inputs changed before runtime refresh.');
    assertCurrent();
    if (key === 'package' && text !== null) manifest = JSON.parse(text);
  }
  assertCurrent();
  const dependencies = Object.assign({}, ...['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].map(key => manifest?.[key]));
  if (!manifest || names.some(name => removed.length ? Object.hasOwn(dependencies, name) : !Object.hasOwn(dependencies, name))) {
    return failure('The original library mutation is not represented by the saved dependencies.');
  }
  return environment;
}
