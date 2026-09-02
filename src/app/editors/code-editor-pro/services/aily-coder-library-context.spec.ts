import {
  normalizeAilyCoderHostLanguage,
  toAilyCoderWorkbenchLocale,
} from './aily-coder-library-context';

describe('Aily Coder embed language preferences', () => {
  it('maps host locales to language packs loaded before Workbench startup', () => {
    expect(toAilyCoderWorkbenchLocale('zh_cn')).toBe('zh-hans');
    expect(toAilyCoderWorkbenchLocale('zh-HK')).toBe('zh-hant');
    expect(toAilyCoderWorkbenchLocale('pt')).toBe('pt-br');
    expect(toAilyCoderWorkbenchLocale('en')).toBeNull();
    expect(toAilyCoderWorkbenchLocale('ar')).toBeNull();
  });

  it('normalizes host language identity independently from the Workbench fallback', () => {
    expect(normalizeAilyCoderHostLanguage('zh-CN')).toBe('zh_cn');
    expect(normalizeAilyCoderHostLanguage('AR')).toBe('ar');
    expect(normalizeAilyCoderHostLanguage('')).toBe('en');
  });
});
