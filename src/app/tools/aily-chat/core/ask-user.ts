/**
 * ask_user data contracts shared by the runtime owner and question UI.
 */

/** Single answer option. */
export interface AskUserOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** Question definition shown by the chat runtime interaction host. */
export interface AskUserQuestion {
  header?: string;
  id?: string;
  question: string;
  options?: AskUserOption[];
  allow_freeform?: boolean;
  multi_select?: boolean;
  allowFreeform?: boolean;
  allowFreeformInput?: boolean;
  multiSelect?: boolean;
}

/** Tool input shape. */
export interface AskUserArgs {
  questions: AskUserQuestion[];
}

/** Answer for one question. */
export interface AskUserAnswer {
  selected: string[];
  freeText: string | null;
  skipped: boolean;
}

/** Complete answer payload for an ask_user request. */
export interface AskUserFullResponse {
  answers: Record<string, AskUserAnswer>;
}

export interface AskUserPresentationContext {
  readonly toolCallId?: string;
  readonly sourceAgentRole?: 'main' | 'subagent';
  readonly subAgentInvocationId?: string;
  readonly parentToolCallId?: string;
}

export interface AskUserBridgeResponse {
  answer: string;
  cancelled: boolean;
  fullResponse?: AskUserFullResponse;
}
