import { normalizePlaygroundPage, PlaygroundSearchHistory } from './playground-search-history';

describe('PlaygroundSearchHistory', () => {
  it('returns text searches and tag switches in reverse order', () => {
    const history = new PlaygroundSearchHistory();

    history.visit({ keyword: 'robot', page: 1 });
    history.visit({ keyword: 'ESP32S3', page: 1 });
    history.visit({ keyword: 'SenseCraft AI', page: 1 });

    expect(history.canGoBack).toBeTrue();
    expect(history.back()).toEqual({ keyword: 'ESP32S3', page: 1 });
    expect(history.back()).toEqual({ keyword: 'robot', page: 1 });
    expect(history.back()).toEqual({ keyword: '', page: 1 });
    expect(history.canGoBack).toBeFalse();
  });

  it('returns pagination changes with their search query', () => {
    const history = new PlaygroundSearchHistory();

    history.reset({ keyword: 'UNO R4', page: 2 });
    history.visit({ keyword: 'UNO R4', page: 3 });
    history.visit({ keyword: 'ESP32S3', page: 1 });

    expect(history.back()).toEqual({ keyword: 'UNO R4', page: 3 });
    expect(history.back()).toEqual({ keyword: 'UNO R4', page: 2 });
    expect(history.back()).toBeNull();
  });

  it('does not add duplicate consecutive searches', () => {
    const history = new PlaygroundSearchHistory();

    history.visit({ keyword: 'AI-VOX', page: 1 });
    history.visit({ keyword: 'AI-VOX', page: 1 });

    expect(history.back()).toEqual({ keyword: '', page: 1 });
    expect(history.canGoBack).toBeFalse();
  });

  it('normalizes invalid route page values', () => {
    expect(normalizePlaygroundPage('3')).toBe(3);
    expect(normalizePlaygroundPage('0')).toBe(1);
    expect(normalizePlaygroundPage('invalid')).toBe(1);
  });
});
