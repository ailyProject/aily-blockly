import { sameAbsProjectDirectory } from './abs-project-path';

describe('ABS live project directory matching', () => {
  it('accepts aliases of the same existing directory without rebinding the scope', async () => {
    const realpath = async (path: string) => path.replace(/^\/var\//, '/private/var/');
    expect(await sameAbsProjectDirectory('/var/project', '/private/var/project', realpath, false)).toBeTrue();
    expect(await sameAbsProjectDirectory('/var/project', '/private/var/other', realpath, false)).toBeFalse();
  });
  it('does not fold case on a case-sensitive filesystem or guess an unavailable alias', async () => {
    expect(await sameAbsProjectDirectory('/Projects/A', '/Projects/a', async p => p, false)).toBeFalse();
    expect(await sameAbsProjectDirectory('/var/project', '/private/var/project', undefined, false)).toBeFalse();
    expect(await sameAbsProjectDirectory('/alias', '/project', async () => { throw Error('missing'); }, false)).toBeFalse();
  });
  it('retains Windows spelling compatibility and rejects absent projects', async () => {
    expect(await sameAbsProjectDirectory('C:\\Project\\', 'c:/project', undefined, true)).toBeTrue();
    expect(await sameAbsProjectDirectory('', '', undefined, true)).toBeFalse();
  });
});
