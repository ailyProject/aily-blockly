import { fakeAsync, tick } from '@angular/core/testing';
import { FooterComponent } from './footer.component';

describe('footer transient save status', () => {
  function fixture() {
    const footer: any = Object.create(FooterComponent.prototype);
    footer.cd = { detectChanges() {} }; return footer;
  }

  it('honors the autosave status duration without changing the shared event', fakeAsync(() => {
    const footer = fixture(), event = { state: 'done', text: 'Auto save succeeded', timeout: 3000 };
    footer.changeState(event); tick(2999); expect(footer.actionData.text).toBe(event.text);
    tick(1); expect(footer.actionData).toBeNull(); expect(event.timeout).toBe(3000);
  }));

  it('does not let a completed save timer clear a newer long-running task', fakeAsync(() => {
    const footer = fixture(); footer.changeState({ state: 'done', text: 'Auto save succeeded', timeout: 3000 });
    tick(1000); footer.changeState({ state: 'doing', text: 'Building' }); tick(10000);
    expect(footer.actionData.text).toBe('Building');
  }));
});
