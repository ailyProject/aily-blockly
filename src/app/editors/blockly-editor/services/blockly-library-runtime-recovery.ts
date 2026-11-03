import { sha256Hex } from '../../../utils/crypto.utils';
import type { BlocklyWorkspaceRecoveryGrant } from './blockly-workspace-edit-lease';
import type { BlocklyLibraryRuntimeRebuildOptions } from './blockly.service';
import { isAilyLibraryPackageName, type ProjectRecoveryFiles } from '@shared/public-api';

export interface RuntimeRecoveryDescription {
  version: 1;
  token: string;
  requestId: string;
  project: string;
  snapshotHash: string;
  status: 'available' | 'running' | 'completed' | 'failed';
  ready: boolean;
  sourcePreserved: true;
  candidateApplied: false;
  requiredLibraries: string[];
  failure?: { code: string; message: string };
}

export interface RuntimeRecoveryRecord {
  project: string;
  path: string;
  documentText: string;
  sourceFiles: ProjectRecoveryFiles;
  scope: readonly unknown[];
  options: BlocklyLibraryRuntimeRebuildOptions;
  restoreCheckpoint(): void;
  grant?: BlocklyWorkspaceRecoveryGrant;
  description?: RuntimeRecoveryDescription;
  attemptedInput?: string;
  offeredInput?: string;
  previous?: RuntimeRecoveryDescription;
  describing?: Promise<RuntimeRecoveryDescription>;
}

/** One retained document and one attempt per exact runtime input. Public tokens
 * never carry the private edit-gate grant. Observing a request cannot restart it. */
export async function describeRuntimeRecovery(record: RuntimeRecoveryRecord, input: string): Promise<RuntimeRecoveryDescription> {
  if (record.describing) return record.describing;
  const task = describe(record, input);
  record.describing = task;
  try { return await task; } finally { if (record.describing === task) record.describing = undefined; }
}

async function describe(record: RuntimeRecoveryRecord, input: string): Promise<RuntimeRecoveryDescription> {
  if (!record.description || record.description.status === 'failed' && record.attemptedInput !== input
    || record.description.status === 'available' && record.offeredInput !== input) {
    const requestId = crypto.randomUUID();
    const snapshotHash = 'sha256:' + await sha256Hex(record.documentText);
    record.offeredInput = input;
    if (record.description?.status === 'failed') record.previous = record.description;
    record.description = { version: 1, project: record.project, requestId, snapshotHash,
      token: 'sha256:' + await sha256Hex(JSON.stringify({ requestId, snapshotHash, input })),
      status: 'available', ready: false, sourcePreserved: true, candidateApplied: false,
      requiredLibraries: [...record.options.libraryNames] };
  }
  return { ...record.description, requiredLibraries: [...record.description.requiredLibraries],
    ...(record.description.failure ? { failure: { ...record.description.failure } } : {}) };
}

export function runtimeRecoveryLibraries(record: RuntimeRecoveryRecord): string[] {
  const fs = window['fs'], path = `${record.project}/package.json`;
  const manifest = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : record.options.packageJson;
  const names = Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies, ...manifest?.optionalDependencies })
    .filter(isAilyLibraryPackageName);
  return [...new Set([...record.options.libraryNames, ...names])];
}

/** Only a change detector for bounded retries, never proof of runtime readiness. */
export function runtimeRecoveryInput(record: RuntimeRecoveryRecord): string {
  const fs = window['fs'];
  const read = (path: string) => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
  const inputs: unknown[] = [read(`${record.project}/package.json`)];
  for (const library of runtimeRecoveryLibraries(record)) {
    const base = `${record.project}/node_modules/${library}`;
    inputs.push([library, ...['package.json', 'block.json', 'toolbox.json', 'generator.js'].map(name => read(`${base}/${name}`))]);
    const translations = `${base}/i18n`;
    if (fs.existsSync(translations)) inputs.push(fs.readdirSync(translations).filter((name: string) => name.endsWith('.json'))
      .sort().map((name: string) => [name, read(`${translations}/${name}`)]));
  }
  return JSON.stringify(inputs);
}
