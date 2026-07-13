import { Injectable, inject } from '@angular/core';

import { ProjectService } from '../../../services/project.service';
import { AilyChatHostInitializerService } from './aily-chat-host-initializer.service';
import { CHAT_RUNTIME_OWNER_ENDPOINT } from './chat-runtime-owner-ports';

type RuntimeHostEnvironment = Readonly<Record<string, unknown>>;

function normalizeRuntimeHostFlag(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function readRuntimeHostEnvironment(): RuntimeHostEnvironment {
  const runtimeGlobal = globalThis as typeof globalThis & {
    process?: { env?: RuntimeHostEnvironment };
  };
  return runtimeGlobal.process?.env ?? {};
}

export function shouldStartRendererRuntimeOwner(env: RuntimeHostEnvironment = readRuntimeHostEnvironment()): boolean {
  const rendererOwnerFlag = normalizeRuntimeHostFlag(
    env['AILY_CHAT_RENDERER_RUNTIME_OWNER'] ?? env['__AILY_CHAT_RENDERER_RUNTIME_OWNER__'],
  );
  if (rendererOwnerFlag === '0' || rendererOwnerFlag === 'false' || rendererOwnerFlag === 'off') {
    console.info('[AilyChat][RendererRuntimeOwnerBootstrap]', {
      phase: 'skip',
      reason: 'renderer-flag-off',
      rendererOwnerFlag,
    });
    return false;
  }
  if (rendererOwnerFlag === '1' || rendererOwnerFlag === 'true' || rendererOwnerFlag === 'on') {
    console.info('[AilyChat][RendererRuntimeOwnerBootstrap]', {
      phase: 'allow',
      reason: 'renderer-flag-on',
      rendererOwnerFlag,
    });
    return true;
  }

  const executionHostMode = normalizeRuntimeHostFlag(
    env['AILY_CHAT_EXECUTION_HOST'] ?? env['__AILY_CHAT_EXECUTION_HOST__'],
  );
  if (executionHostMode
    && executionHostMode !== '0'
    && executionHostMode !== 'false'
    && executionHostMode !== 'off') {
    console.info('[AilyChat][RendererRuntimeOwnerBootstrap]', {
      phase: 'skip',
      reason: 'execution-host-enabled',
      executionHostMode,
    });
    return false;
  }

  console.info('[AilyChat][RendererRuntimeOwnerBootstrap]', {
    phase: 'skip',
    reason: 'renderer-owner-default-off',
    executionHostMode: executionHostMode || 'off',
  });
  return false;
}

@Injectable()
export class ChatRuntimeHostBootstrapService {
  private readonly hostInitializer = inject(AilyChatHostInitializerService);
  private readonly projectService = inject(ProjectService);
  private readonly runtimeOwnerEndpoint = inject(CHAT_RUNTIME_OWNER_ENDPOINT);
  private registrationPromise: Promise<void> | null = null;

  async startHostRuntimeOwner(): Promise<void> {
    if (!shouldStartRendererRuntimeOwner()) {
      return;
    }
    if (this.registrationPromise) {
      return this.registrationPromise;
    }

    this.registrationPromise = Promise.resolve()
      .then(async () => {
        this.hostInitializer.ensureInitialized();
        await this.projectService.ensureProjectRootPath();
        await this.runtimeOwnerEndpoint.startElectronHostRuntimeOwner();
      })
      .finally(() => {
        this.registrationPromise = null;
      });
    return this.registrationPromise;
  }
}
