import type { IAilySkill } from './skill-types';
import { SkillRegistry } from './skill-registry';

export interface BlocklySkillCustomizationProvider {
  contributeSkills(): readonly IAilySkill[];
  onSkillsChanged?(listener: () => void): { dispose(): void };
}

export function createBlocklySkillCustomizationProvider(): BlocklySkillCustomizationProvider {
  return {
    contributeSkills(): readonly IAilySkill[] {
      return SkillRegistry.getAll().filter(shouldExposeSkillInSessionCustomization);
    },
    onSkillsChanged(listener: () => void) {
      return SkillRegistry.onDidChange(listener);
    },
  };
}

function shouldExposeSkillInSessionCustomization(skill: IAilySkill): boolean {
  const path = typeof skill.skillMdPath === 'string' ? skill.skillMdPath.trim() : '';
  if (!path) {
    return false;
  }

  return skill.origin.type !== 'url';
}