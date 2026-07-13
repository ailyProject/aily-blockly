import { Injectable, inject } from '@angular/core';

import type { UserInteractionToolApprovalPolicy } from '../helpers/user-interaction.helper';
import { AilyChatConfigService } from './aily-chat-config.service';

interface SessionToolApprovalState {
  readonly toolNames: Set<string>;
  readonly terminalRules: Set<string>;
  readonly combinationKeys: Set<string>;
  allowAllTerminalCommands: boolean;
}

function normalizeSessionResource(sessionResource: string | null | undefined): string {
  return typeof sessionResource === 'string' ? sessionResource.trim() : '';
}

function normalizeApprovalKey(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

@Injectable()
export class ChatRuntimeOwnerToolApprovalPolicyService implements UserInteractionToolApprovalPolicy {
  private readonly config = inject(AilyChatConfigService);
  private readonly sessionApprovalStates = new Map<string, SessionToolApprovalState>();

  get terminalAllowList(): string[] {
    return this.config.terminalAllowList;
  }

  set terminalAllowList(value: string[]) {
    this.config.terminalAllowList = value;
  }

  save(): boolean | void {
    return this.config.save();
  }

  hasSessionToolApprovalRule(sessionResource: string | null | undefined, toolName: string): boolean {
    const normalizedToolName = normalizeApprovalKey(toolName);
    return !!normalizedToolName && this.readSessionApprovalState(sessionResource)?.toolNames.has(normalizedToolName) === true;
  }

  addSessionToolApprovalRule(sessionResource: string | null | undefined, toolName: string): boolean {
    const normalizedToolName = normalizeApprovalKey(toolName);
    if (!normalizedToolName) {
      return false;
    }

    const state = this.ensureSessionApprovalState(sessionResource);
    const beforeSize = state.toolNames.size;
    state.toolNames.add(normalizedToolName);
    return state.toolNames.size !== beforeSize;
  }

  getSessionTerminalApprovalRules(sessionResource: string | null | undefined): string[] {
    return [...(this.readSessionApprovalState(sessionResource)?.terminalRules ?? [])];
  }

  addSessionTerminalApprovalRule(sessionResource: string | null | undefined, rule: string): boolean {
    const normalizedRule = normalizeApprovalKey(rule);
    if (!normalizedRule) {
      return false;
    }

    const state = this.ensureSessionApprovalState(sessionResource);
    const beforeSize = state.terminalRules.size;
    state.terminalRules.add(normalizedRule);
    return state.terminalRules.size !== beforeSize;
  }

  hasSessionToolApprovalCombinationKey(
    sessionResource: string | null | undefined,
    combinationKey: string,
  ): boolean {
    const normalizedKey = normalizeApprovalKey(combinationKey);
    return !!normalizedKey && this.readSessionApprovalState(sessionResource)?.combinationKeys.has(normalizedKey) === true;
  }

  addSessionToolApprovalCombinationKey(
    sessionResource: string | null | undefined,
    combinationKey: string,
  ): boolean {
    const normalizedKey = normalizeApprovalKey(combinationKey);
    if (!normalizedKey) {
      return false;
    }

    const state = this.ensureSessionApprovalState(sessionResource);
    const beforeSize = state.combinationKeys.size;
    state.combinationKeys.add(normalizedKey);
    return state.combinationKeys.size !== beforeSize;
  }

  isSessionTerminalAutoApprovalEnabled(sessionResource: string | null | undefined): boolean {
    return this.readSessionApprovalState(sessionResource)?.allowAllTerminalCommands === true;
  }

  setSessionTerminalAutoApproval(sessionResource: string | null | undefined, enabled: boolean): void {
    this.ensureSessionApprovalState(sessionResource).allowAllTerminalCommands = enabled === true;
  }

  hasWorkspaceToolApprovalRule(projectPath: string | null | undefined, toolName: string): boolean {
    return this.config.hasWorkspaceToolApprovalRule(projectPath, toolName);
  }

  addWorkspaceToolApprovalRule(projectPath: string | null | undefined, toolName: string): boolean {
    return this.config.addWorkspaceToolApprovalRule(projectPath, toolName);
  }

  hasWorkspaceToolApprovalCombinationKey(
    projectPath: string | null | undefined,
    combinationKey: string,
  ): boolean {
    return this.config.hasWorkspaceToolApprovalCombinationKey(projectPath, combinationKey);
  }

  addWorkspaceToolApprovalCombinationKey(
    projectPath: string | null | undefined,
    combinationKey: string,
  ): boolean {
    return this.config.addWorkspaceToolApprovalCombinationKey(projectPath, combinationKey);
  }

  private readSessionApprovalState(sessionResource: string | null | undefined): SessionToolApprovalState | undefined {
    const normalizedSessionResource = normalizeSessionResource(sessionResource);
    return normalizedSessionResource ? this.sessionApprovalStates.get(normalizedSessionResource) : undefined;
  }

  private ensureSessionApprovalState(sessionResource: string | null | undefined): SessionToolApprovalState {
    const normalizedSessionResource = normalizeSessionResource(sessionResource);
    if (!normalizedSessionResource) {
      throw new Error('[AilyChat][ToolApprovalPolicy] session approval requires a session resource.');
    }

    const existing = this.sessionApprovalStates.get(normalizedSessionResource);
    if (existing) {
      return existing;
    }

    const created: SessionToolApprovalState = {
      toolNames: new Set<string>(),
      terminalRules: new Set<string>(),
      combinationKeys: new Set<string>(),
      allowAllTerminalCommands: false,
    };
    this.sessionApprovalStates.set(normalizedSessionResource, created);
    return created;
  }
}
