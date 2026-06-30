import type { TurnRequest } from 'aily-lex/browser';

import type { ResourceItem } from '../core/chat-types';

export type ChatPendingRequestKind = 'queued' | 'steering';

export type PendingFollowupUserSelectedTools = Readonly<Record<string, boolean>>;

export interface PreparedPendingFollowupRequest {
	readonly text: string;
	readonly llmText: string;
	readonly displayText: string;
	readonly requestMetadata?: TurnRequest['metadata'];
	readonly resourceItems?: readonly ResourceItem[];
	readonly sessionAllowedPaths?: readonly string[];
	readonly runtimeOwnerSessionId?: string;
	readonly providerOptionsKey?: string;
	readonly requestedModel?: string;
	readonly requestedPresetId?: string;
	readonly requestModeId?: string;
	readonly requestCustomAgentTarget?: string;
	readonly permissionLevel?: string;
	readonly approvalsReviewer?: 'user' | 'auto_review';
	readonly approvalPolicy?: 'on_request' | 'never';
	readonly userSelectedTools?: PendingFollowupUserSelectedTools;
}

export interface PendingFollowupRequest {
	readonly id: string;
	readonly content: string;
	readonly kind: ChatPendingRequestKind;
	readonly prepared: PreparedPendingFollowupRequest;
}