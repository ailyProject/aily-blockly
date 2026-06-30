import { Injectable, InjectionToken } from '@angular/core';

import type { IWorkspaceChangeCollector } from 'aily-lex/browser';
import { AilyHost } from '../core/host';
import { BlocklyTrackedWorkspaceChangeCollector } from './blockly-tracked-workspace-change-collector';
import { EditingContentStore } from './editing-content-store.service';
import { EditingTimelineRecordingBridge } from './editing-timeline-recording-bridge';
import { EditingTimelineRepository } from './editing-timeline-repository.service';

export interface ChatSessionLexPostTurnResources {
  readonly cwd: string;
  readonly editingTimelineRecorder: EditingTimelineRecordingBridge;
  readonly workspaceChangeCollector: IWorkspaceChangeCollector;
}

export interface ChatSessionLexPostTurnResourceFactory {
  create(sessionId: string, cwd: string): ChatSessionLexPostTurnResources;
}

export const CHAT_SESSION_LEX_POST_TURN_RESOURCE_FACTORY = new InjectionToken<ChatSessionLexPostTurnResourceFactory>(
  'AILY_CHAT_SESSION_LEX_POST_TURN_RESOURCE_FACTORY',
);

@Injectable()
export class ChatSessionLexPostTurnResourceFactoryService implements ChatSessionLexPostTurnResourceFactory {
  create(sessionId: string, cwd: string): ChatSessionLexPostTurnResources {
    return {
      cwd,
      editingTimelineRecorder: new EditingTimelineRecordingBridge(
        new EditingTimelineRepository({
          joinPath: (...parts) => AilyHost.get().path.join(...parts),
        }),
        new EditingContentStore({
          joinPath: (...parts) => AilyHost.get().path.join(...parts),
        }),
        cwd,
        sessionId,
      ),
      workspaceChangeCollector: new BlocklyTrackedWorkspaceChangeCollector(),
    };
  }
}
