/*---------------------------------------------------------------------------------------------
 *  BlocklySkillProvider — bridges blockly SkillRegistryImpl → lex IHostSkillProvider.
 *
 *  Auto-activate skills are contributed to lex's SkillRegistry at agent creation,
 *  ensuring they always appear in the system prompt (Layer 3, <skill> sections).
 *
 *  Non-auto-activate skills are discoverable via the skills listing section
 *  and loadable on-demand via the load_skill tool.
 *--------------------------------------------------------------------------------------------*/

import type { IHostSkillProvider, IHostSkillContribution } from 'aily-lex/browser';
import { SkillRegistry } from './skill-registry';

/**
 * Adapts blockly's filesystem-based SkillRegistryImpl into lex's IHostSkillProvider.
 *
 * Only auto-activate skills are contributed (always in system prompt).
 * On-demand skills are handled by the load_skill tool + skills listing section.
 * The host only contributes skill content/discovery; prompt injection and runtime
 * activation order remain owned by lex SkillRegistry + PromptBuilder.
 */
export class BlocklySkillProvider implements IHostSkillProvider {
  contributeSkills(): IHostSkillContribution[] {
    const autoSkills = SkillRegistry.getAutoActivateSkills();
    return autoSkills.map(skill => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      priority: 80,
      content: skill.content || SkillRegistry.loadSkillContent(skill.metadata.name) || '',
    }));
  }

  onSkillsChanged(listener: () => void): { dispose(): void } {
    return SkillRegistry.onDidChange(listener);
  }
}
