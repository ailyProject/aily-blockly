import { boardRequiresCloudAuth } from './board-auth-gate';

describe('boardRequiresCloudAuth', () => {
  it('requires authentication only for an explicit auth true declaration', () => {
    expect(boardRequiresCloudAuth({ auth: true })).toBeTrue();
    expect(boardRequiresCloudAuth({ auth: false })).toBeFalse();
    expect(boardRequiresCloudAuth({ auth: 'true' })).toBeFalse();
    expect(boardRequiresCloudAuth({})).toBeFalse();
    expect(boardRequiresCloudAuth(null)).toBeFalse();
  });
});
