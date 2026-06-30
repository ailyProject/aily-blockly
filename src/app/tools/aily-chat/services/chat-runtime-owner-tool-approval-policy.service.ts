import { Injectable, inject } from '@angular/core';

import type { UserInteractionToolApprovalPolicy } from '../helpers/user-interaction.helper';
import { AilyChatConfigService } from './aily-chat-config.service';

@Injectable()
export class ChatRuntimeOwnerToolApprovalPolicyService implements UserInteractionToolApprovalPolicy {
  private readonly config = inject(AilyChatConfigService);

  get terminalAllowList(): string[] {
    return this.config.terminalAllowList;
  }

  set terminalAllowList(value: string[]) {
    this.config.terminalAllowList = value;
  }

  save(): boolean | void {
    return this.config.save();
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
}
