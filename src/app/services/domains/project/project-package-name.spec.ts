import {
  deriveProjectPackageName,
  isValidProjectPackageName,
  normalizeProjectPackageName,
} from './project-package-name';

describe('project package names', () => {
  it('trims and lowercases an explicitly entered package name', () => {
    expect(normalizeProjectPackageName('  My_Project  ')).toBe('my_project');
  });

  it('derives lowercase package names from Latin and mixed Chinese project names', () => {
    expect(deriveProjectPackageName('My Demo')).toBe('my_demo');
    expect(deriveProjectPackageName('测试ABC')).toBe('ceshiabc');
  });

  it('converts pinyin umlauts to npm-safe v characters', () => {
    expect(deriveProjectPackageName('绿色')).toBe('lvse');
  });

  it('leaves unsupported punctuation visible for validation', () => {
    const packageName = normalizeProjectPackageName('My.Project');
    expect(packageName).toBe('my.project');
    expect(isValidProjectPackageName(packageName)).toBeFalse();
    expect(isValidProjectPackageName('my_project-1')).toBeTrue();
  });
});
