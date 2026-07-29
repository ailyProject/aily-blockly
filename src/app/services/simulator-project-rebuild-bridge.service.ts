import { Injectable } from '@angular/core';
import { BackgroundAgentService } from './background-agent.service';
import {
  ActionFeedback,
  ActionService,
} from './action.service';
import { ProjectService } from './project.service';

interface ProjectRebuildRequest {
  schemaVersion: 1;
  kind: 'aily-project-simulator-rebuild-request';
  requestId: string;
  projectIdentity: string;
  sessionId: string;
  sceneId: string;
  action: 'reconcile-and-build';
  expectedGraphSemanticRevision: string;
  sceneDocument: Record<string, unknown>;
}

interface RebuildTransport {
  requestId: string;
  rendererGeneration: number;
}

@Injectable({ providedIn: 'root' })
export class SimulatorProjectRebuildBridgeService {
  private started = false;
  private readonly awaitingReconciliation = new Map<string, string>();

  constructor(
    private readonly backgroundAgent: BackgroundAgentService,
    private readonly actionService: ActionService,
    private readonly projectService: ProjectService,
  ) {}

  start(): void {
    if (this.started) return;
    const api = (window as any).electronAPI?.simulatorSubapp;
    if (
      typeof api?.onProjectRebuildRequested !== 'function'
      || typeof api?.respondProjectRebuild !== 'function'
    ) {
      return;
    }
    this.started = true;
    api.onProjectRebuildRequested((
      rawRequest: unknown,
      transport: RebuildTransport,
    ) => {
      void this.handleRequest(api, rawRequest, transport);
    });
  }

  private async handleRequest(
    api: {
      respondProjectRebuild(
        transport: RebuildTransport,
        result: Record<string, unknown>,
      ): void;
    },
    rawRequest: unknown,
    transport: RebuildTransport,
  ): Promise<void> {
    const request = validateProjectRebuildRequest(rawRequest);
    if (!request) {
      api.respondProjectRebuild(
        transport,
        createRejectedResult(rawRequest, 'adapter-unavailable'),
      );
      return;
    }
    const identity = JSON.stringify(request);
    const pendingIdentity = this.awaitingReconciliation.get(request.requestId);
    if (pendingIdentity === undefined) {
      api.respondProjectRebuild(
        transport,
        this.requestReconciliation(request, identity),
      );
      return;
    }
    if (pendingIdentity !== identity) {
      api.respondProjectRebuild(
        transport,
        createRejectedResult(request, 'adapter-unavailable'),
      );
      return;
    }
    this.awaitingReconciliation.delete(request.requestId);
    api.respondProjectRebuild(
      transport,
      await this.compileReconciledProject(request),
    );
  }

  private requestReconciliation(
    request: ProjectRebuildRequest,
    identity: string,
  ) {
    const opened = this.backgroundAgent.requestSimulatorSceneCodeReconciliation({
      sceneId: request.sceneId,
      expectedGraphSemanticRevision: request.expectedGraphSemanticRevision,
      sceneDocument: request.sceneDocument,
    });
    if (opened) {
      this.awaitingReconciliation.set(request.requestId, identity);
      while (this.awaitingReconciliation.size > 16) {
        const oldest = this.awaitingReconciliation.keys().next().value;
        if (typeof oldest !== 'string') break;
        this.awaitingReconciliation.delete(oldest);
      }
    }
    return createRejectedResult(
      request,
      opened ? 'reconciliation-required' : 'adapter-unavailable',
    );
  }

  private async compileReconciledProject(request: ProjectRebuildRequest) {
    if (!this.actionService.getListenerIds().includes('builder-compile-begin')) {
      return createRejectedResult(request, 'adapter-unavailable');
    }
    const feedback = await new Promise<ActionFeedback>((resolve) => {
      this.actionService.dispatch(
        'compile-begin',
        {
          reason: 'simulator-scene-rebuild',
          graphSemanticRevision: request.expectedGraphSemanticRevision,
        },
        resolve,
        25 * 60 * 1000,
      );
    });
    if (
      !feedback.success
      || !isRecord(feedback.data)
      || feedback.data['success'] !== true
    ) {
      return createRejectedResult(request, 'build-failed');
    }
    try {
      const projectRoot = this.projectService.currentProjectPath;
      if (!projectRoot) {
        return createRejectedResult(request, 'project-not-active');
      }
      const manifestPath = window['path'].join(
        projectRoot,
        '.build',
        'aily-artifact-manifest.json',
      );
      const manifest = JSON.parse(
        window['fs'].readFileSync(manifestPath, 'utf8'),
      );
      if (
        !isRecord(manifest)
        || !/^[a-f0-9]{64}$/.test(String(manifest['artifactId']))
        || !isRecord(manifest['build'])
        || !isRecord(manifest['build']['graph'])
        || manifest['build']['graph']['graphSemanticRevision']
          !== request.expectedGraphSemanticRevision
      ) {
        return createRejectedResult(request, 'build-failed');
      }
      return {
        schemaVersion: 1,
        kind: 'aily-project-simulator-rebuild-result',
        requestId: request.requestId,
        projectIdentity: request.projectIdentity,
        sessionId: request.sessionId,
        sceneId: request.sceneId,
        status: 'built',
        artifactId: manifest['artifactId'],
        graphSemanticRevision: request.expectedGraphSemanticRevision,
        errorCode: null,
      };
    } catch {
      return createRejectedResult(request, 'build-failed');
    }
  }
}

function validateProjectRebuildRequest(
  value: unknown,
): ProjectRebuildRequest | null {
  if (!isRecord(value)) return null;
  const keys = [
    'action',
    'expectedGraphSemanticRevision',
    'kind',
    'projectIdentity',
    'requestId',
    'sceneDocument',
    'sceneId',
    'schemaVersion',
    'sessionId',
  ];
  if (Object.keys(value).sort().join('\0') !== keys.sort().join('\0')) return null;
  if (
    value['schemaVersion'] !== 1
    || value['kind'] !== 'aily-project-simulator-rebuild-request'
    || value['action'] !== 'reconcile-and-build'
    || !/^rebuild-v1-[a-f0-9]{64}$/.test(String(value['requestId']))
    || !/^session-v1-[a-f0-9]{32}$/.test(String(value['sessionId']))
    || !/^[a-f0-9]{64}$/.test(String(value['expectedGraphSemanticRevision']))
    || typeof value['projectIdentity'] !== 'string'
    || typeof value['sceneId'] !== 'string'
    || !isRecord(value['sceneDocument'])
  ) {
    return null;
  }
  return value as unknown as ProjectRebuildRequest;
}

function createRejectedResult(
  rawRequest: unknown,
  errorCode:
    | 'adapter-unavailable'
    | 'project-not-active'
    | 'reconciliation-required'
    | 'build-failed',
) {
  const request = isRecord(rawRequest) ? rawRequest : {};
  return {
    schemaVersion: 1,
    kind: 'aily-project-simulator-rebuild-result',
    requestId: stringField(request, 'requestId'),
    projectIdentity: stringField(request, 'projectIdentity'),
    sessionId: stringField(request, 'sessionId'),
    sceneId: stringField(request, 'sceneId'),
    status: 'rejected',
    artifactId: null,
    graphSemanticRevision: stringField(
      request,
      'expectedGraphSemanticRevision',
    ),
    errorCode,
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] as string : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
