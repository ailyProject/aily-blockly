import { resolveConfiguredProjectRootPath } from './project-root-path';

describe('resolveConfiguredProjectRootPath', () => {
  it('expands the default project path with the host Documents directory', () => {
    expect(resolveConfiguredProjectRootPath('%HOMEPATH%\\Documents\\aily-project', {
      userDocuments: '/Users/test/Documents',
      userHome: '/Users/test',
      separator: '/',
    })).toBe('/Users/test/Documents/aily-project');
  });

  it('expands home-relative paths with the host separator', () => {
    expect(resolveConfiguredProjectRootPath('~/Projects/aily', {
      userDocuments: 'C:\\Users\\test\\Documents',
      userHome: 'C:\\Users\\test',
      separator: '\\',
    })).toBe('C:\\Users\\test\\Projects\\aily');
  });

  it('keeps a custom absolute path unchanged', () => {
    expect(resolveConfiguredProjectRootPath('/Volumes/Work/Aily Projects', {
      userDocuments: '/Users/test/Documents',
      userHome: '/Users/test',
      separator: '/',
    })).toBe('/Volumes/Work/Aily Projects');
  });

  it('returns an empty path for an empty configuration', () => {
    expect(resolveConfiguredProjectRootPath('  ', {
      userDocuments: '/Users/test/Documents',
      userHome: '/Users/test',
      separator: '/',
    })).toBe('');
  });
});
