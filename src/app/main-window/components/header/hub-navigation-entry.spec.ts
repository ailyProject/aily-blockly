import { HeaderComponent } from './header.component';
import { GuideComponent } from '../../../pages/guide/guide.component';

describe('Hub project-square entry wiring', () => {
  it('routes both desktop menus and the guide button through Hub account navigation', async () => {
    const hub = { open: jasmine.createSpy('open').and.resolveTo() };
    const header = Object.create(HeaderComponent.prototype);
    header.hubNavigation = hub;
    await header.process({ action: 'example-open' });
    const guide = Object.create(GuideComponent.prototype);
    guide.hubNavigation = hub;
    guide.process({ action: 'playground-open' });
    guide.gotoPlayground();
    expect(hub.open.calls.allArgs()).toEqual([['/projects'], ['/projects'], ['/projects']]);
  });
});
