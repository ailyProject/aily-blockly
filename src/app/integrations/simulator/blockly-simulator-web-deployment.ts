import type { BlocklySimulatorWebDeployment } from './blockly-simulator-web-publication';
import type { SimulatorWebSelectedProjectContext } from './simulator-web-product.source';
import type { SimulatorCapturedProjectActivation } from './simulator-web-project-activation';
import type { SimulatorWebStartupInput } from './simulator-web-product.service';

/** Deployment inputs identify the release and account instance. Only the
 * original ProjectService publication may supply a selected project scope. */
export interface BlocklyProjectScopedWebDeploymentOptions {
  readonly trustedOrigin: string;
  readonly releaseId: string;
  readonly instance: Readonly<{
    runtimeId: string; version: string; ownerKey: string; subjectHash: string;
    configuration: Readonly<{ url: string; sizeBytes: number; sha256: string }>;
  }>;
  readonly instruments?: boolean;
  readonly deferPresentation?: boolean;
  readonly technicalControls?: boolean;
  readInputs(input: Readonly<{
    activation: SimulatorCapturedProjectActivation;
    context: SimulatorWebSelectedProjectContext;
    releaseBaseURL: string;
    signal: AbortSignal;
    requireCurrent(): void;
  }>): Promise<Readonly<{
    authorization: SimulatorWebStartupInput['authorization'];
    catalog: SimulatorWebStartupInput['catalog'];
    runtime?: SimulatorWebStartupInput['runtime'];
  }>>;
}

const sha256 = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const contextKeys = ['schemaVersion', 'kind', 'projectIdentity', 'workspaceIdentity',
  'activeSceneId', 'activeArtifactRevision', 'workspaceSourceSha256'] as const;
function fail(): never { throw new TypeError('Invalid project-scoped Blockly Web deployment.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length
    || Object.keys(descriptors).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) fail();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^\S{1,256}$/u.test(value);
}
function captureContext(value: unknown): SimulatorWebSelectedProjectContext {
  const context = record(value, contextKeys);
  if (context['schemaVersion'] !== 1 || context['kind'] !== 'aily-simulator-host-project-context-snapshot'
    || !identifier(context['projectIdentity']) || !identifier(context['workspaceIdentity'])
    || context['activeSceneId'] !== 'main'
    || context['activeArtifactRevision'] !== null
      && (typeof context['activeArtifactRevision'] !== 'string' || !sha256.test(context['activeArtifactRevision']))
    || context['workspaceSourceSha256'] !== null
      && (typeof context['workspaceSourceSha256'] !== 'string' || !sha256.test(context['workspaceSourceSha256']))) fail();
  return Object.freeze(context) as unknown as SimulatorWebSelectedProjectContext;
}

/** One immutable startup binding per original activation. There is no project
 * registry, Scene Store or Artifact replacement here; a new revision requires
 * the normal caller to retire its old binding and read a new one. */
export function createBlocklyProjectScopedWebDeployment(
  options: BlocklyProjectScopedWebDeploymentOptions,
): BlocklySimulatorWebDeployment {
  const supplied = record(options, ['trustedOrigin', 'releaseId', 'instance', 'readInputs'],
    ['instruments', 'deferPresentation', 'technicalControls']);
  const { trustedOrigin, releaseId, instruments, deferPresentation, technicalControls } = supplied;
  const instance = record(supplied['instance'], ['runtimeId', 'version', 'ownerKey', 'subjectHash', 'configuration']);
  const configuration = record(instance['configuration'], ['url', 'sizeBytes', 'sha256']);
  if (typeof trustedOrigin !== 'string' || typeof releaseId !== 'string' || !sha256.test(releaseId)
    || typeof supplied['readInputs'] !== 'function'
    || typeof instance['runtimeId'] !== 'string' || !uuid.test(instance['runtimeId'])
    || typeof instance['subjectHash'] !== 'string' || !sha256.test(instance['subjectHash'])
    || typeof instance['version'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(instance['version'])
    || !identifier(instance['ownerKey'])
    || [instruments, deferPresentation, technicalControls].some(value => value !== undefined && typeof value !== 'boolean')) fail();
  const origin = new URL(trustedOrigin);
  if (origin.origin !== trustedOrigin || origin.username || origin.password || origin.search || origin.hash
    || globalThis.location.origin !== trustedOrigin
    || origin.protocol !== 'https:' && !(origin.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) fail();
  const releaseBaseURL = new URL('/releases/' + releaseId + '/', trustedOrigin).href;
  if (configuration['url'] !== new URL('/instances/' + instance['runtimeId'] + '/entitlement-config.json', trustedOrigin).href
    || !Number.isSafeInteger(configuration['sizeBytes']) || (configuration['sizeBytes'] as number) < 1
    || (configuration['sizeBytes'] as number) > 65536
    || typeof configuration['sha256'] !== 'string' || !sha256.test(configuration['sha256'])) fail();
  const frozenInstance = Object.freeze({ runtimeId: instance['runtimeId'], version: instance['version'],
    ownerKey: instance['ownerKey'], subjectHash: instance['subjectHash'] });
  const instanceAuthority = Object.freeze({ schemaVersion: 1, kind: 'aily-browser-instance-entitlement',
    expectedSubjectHash: frozenInstance.subjectHash, configuration: Object.freeze(configuration) });
  const readInputs = options.readInputs.bind(options);

  return Object.freeze<BlocklySimulatorWebDeployment>({
    async readStartup({ activation, context, signal }) {
      const path = activation.path, projectSessionId = activation.projectSessionId, activationSignal = activation.signal;
      if (typeof path !== 'string' || !path || !identifier(projectSessionId)
        || typeof activation.requireCurrent !== 'function' || typeof activationSignal?.throwIfAborted !== 'function') fail();
      const requireActivation = activation.requireCurrent.bind(activation);
      const captured = captureContext(context);
      const requireCurrent = () => {
        signal.throwIfAborted(); activationSignal.throwIfAborted(); requireActivation();
        if (globalThis.location.origin !== trustedOrigin || activation.path !== path
          || activation.projectSessionId !== projectSessionId || activation.signal !== activationSignal) fail();
        const current = captureContext(context);
        if (contextKeys.some(key => current[key] !== captured[key])) fail();
      };
      requireCurrent();
      const inputs = await readInputs(Object.freeze({ activation, context: Object.freeze(structuredClone(captured)),
        signal, releaseBaseURL, requireCurrent }));
      requireCurrent();
      if (!inputs || typeof (inputs.authorization as { readResponse?: unknown } | undefined)?.readResponse !== 'function'
        || typeof (inputs.catalog as { hostProviderSnapshot?: unknown } | undefined)?.hostProviderSnapshot !== 'function'
        || inputs.runtime !== undefined && (!inputs.runtime || typeof inputs.runtime !== 'object' || Array.isArray(inputs.runtime))
        || captured.activeArtifactRevision !== null && !inputs.runtime) fail();
      // Project and Artifact providers remain the publication's original
      // capabilities. A readInputs result cannot substitute either of them.
      return Object.freeze({
        identity: Object.freeze({ ...frozenInstance, projectIdentity: captured.projectIdentity,
          sceneId: captured.activeSceneId, artifactRevision: captured.activeArtifactRevision }),
        resources: Object.freeze({ trustedOrigin, releaseBaseURL, artifactBaseURL: null }),
        instanceAuthority, authorization: inputs.authorization, catalog: inputs.catalog,
        ...(inputs.runtime ? { runtime: inputs.runtime } : {}), workspace: 'browser:' + captured.projectIdentity,
        instruments: instruments === true, operationWaitMs: 5000, cleanupWaitMs: 3000,
        ...(deferPresentation !== undefined ? { deferPresentation: deferPresentation as boolean } : {}),
        ...(technicalControls !== undefined ? { technicalControls: technicalControls as boolean } : {}),
      });
    },
  });
}
