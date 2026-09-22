import { resolveSubappMoreMenuPosition } from './subapp-more-menu-layout';

describe('subapp more menu placement', () => {
  it('aligns its actual right edge with the trigger below the button', () => {
    expect(resolveSubappMoreMenuPosition(
      { right: 800, top: 100, bottom: 126 }, 840, 600
    )).toEqual({ right: 40, top: 129 });
  });

  it('opens above a bottom-row trigger while retaining the right alignment', () => {
    expect(resolveSubappMoreMenuPosition(
      { right: 800, top: 560, bottom: 586 }, 840, 600
    )).toEqual({ right: 40, top: 491 });
  });

  it('keeps a full-width menu inside the safe margins on narrow viewports', () => {
    expect(resolveSubappMoreMenuPosition(
      { right: 26, top: 0, bottom: 26 }, 100, 100
    )).toEqual({ right: 8, top: 8 });
  });
});
