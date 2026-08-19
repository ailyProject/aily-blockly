import { normalizeLanguageCode } from './language-code';

describe('normalizeLanguageCode', () => {
  it('normalizes simplified Chinese variants', () => {
    expect(normalizeLanguageCode('zh')).toBe('zh_cn');
    expect(normalizeLanguageCode('zh-CN')).toBe('zh_cn');
    expect(normalizeLanguageCode('zh-Hans')).toBe('zh_cn');
  });

  it('normalizes traditional Chinese variants', () => {
    expect(normalizeLanguageCode('zh-HK')).toBe('zh_hk');
    expect(normalizeLanguageCode('zh-TW')).toBe('zh_hk');
    expect(normalizeLanguageCode('zh-Hant')).toBe('zh_hk');
    expect(normalizeLanguageCode('zh-CHT')).toBe('zh_hk');
  });

  it('uses the supported base language for regional variants', () => {
    expect(normalizeLanguageCode('en-US')).toBe('en');
    expect(normalizeLanguageCode('pt-BR')).toBe('pt');
    expect(normalizeLanguageCode('JA_jp')).toBe('ja');
  });

  it('uses stable fallbacks for missing and unsupported languages', () => {
    expect(normalizeLanguageCode(undefined)).toBe('zh_cn');
    expect(normalizeLanguageCode('')).toBe('zh_cn');
    expect(normalizeLanguageCode('it-IT')).toBe('en');
  });
});
