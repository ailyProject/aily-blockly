import { pinyin } from 'pinyin-pro';

export const PROJECT_PACKAGE_NAME_PATTERN = /^[a-z0-9_-]+$/;

const CHINESE_CHARACTER_PATTERN = /[\u4e00-\u9fa5]/;

/** Normalize an explicitly entered package name without changing its structure. */
export function normalizeProjectPackageName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Derive a normalized package-name default from a project display name. */
export function deriveProjectPackageName(value: unknown): string {
  const projectName = String(value ?? '').trim();
  const romanizedName = CHINESE_CHARACTER_PATTERN.test(projectName)
    ? pinyin(projectName, {
      toneType: 'none',
      separator: '',
      v: true,
    })
    : projectName;

  return normalizeProjectPackageName(romanizedName.replace(/\s/g, '_'));
}

export function isValidProjectPackageName(value: unknown): boolean {
  return PROJECT_PACKAGE_NAME_PATTERN.test(String(value ?? ''));
}
