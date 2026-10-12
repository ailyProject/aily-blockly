import {Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {provideAnimations} from '@angular/platform-browser/animations';
import {provideRouter, Router, RouterOutlet} from '@angular/router';
import {RoutedContentDirective} from './routed-content.directive';

@Component({selector: 'test-routed-editor', template: '<div>Editor</div>', styles: [':host { position: relative; }']})
class RoutedEditor {}

@Component({
  imports: [RouterOutlet, RoutedContentDirective],
  template: '<div class="middle-box"><router-outlet ailyRoutedContent /></div>',
  styles: [`
    .middle-box { width: 800px; height: 600px; }
    :host ::ng-deep .middle-box > .aily-routed-content { display: block; width: 100%; height: 100%; }
  `],
})
class RoutedShell {}

@Component({imports: [RouterOutlet], template: '<router-outlet />'})
class RoutedRoot {}

describe('RoutedContentDirective', () => {
  let fixture: ComponentFixture<RoutedRoot>;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RoutedRoot, RoutedShell, RoutedEditor],
      providers: [provideAnimations(), provideRouter([
        {path: 'main', loadComponent: async () => RoutedShell, children: [
          {path: 'first', loadComponent: async () => RoutedEditor},
          {path: 'second', loadComponent: async () => RoutedEditor},
        ]},
      ])],
    });
    fixture = TestBed.createComponent(RoutedRoot);
    router = TestBed.inject(Router);
    fixture.detectChanges();
  });

  async function navigate(url: string): Promise<HTMLElement> {
    await router.navigateByUrl('/main' + url);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement.querySelector('test-routed-editor');
  }

  function expectEditorBounds(editor: HTMLElement): void {
    expect(editor.classList.contains('aily-routed-content')).toBeTrue();
    expect(editor.clientWidth).toBe(800);
    expect(editor.clientHeight).toBe(600);
  }

  it('sizes the initial lazy routed editor', async () => {
    expectEditorBounds(await navigate('/first'));
  });

  it('sizes the incoming editor while animations retain the outgoing host', async () => {
    const first = await navigate('/first');
    const second = await navigate('/second');
    expect(second).not.toBe(first);
    expectEditorBounds(second);
    fixture.nativeElement.querySelector('.middle-box').style.height = '360px';
    expect(second.clientHeight).toBe(360);
  });

  it('restores layout when a reused editor is attached', async () => {
    const editor = await navigate('/first');
    const outlet = fixture.debugElement.query(By.directive(RoutedContentDirective)).injector.get(RouterOutlet);
    const route = outlet.activatedRoute;
    const ref = outlet.detach();
    editor.classList.remove('aily-routed-content');
    outlet.attach(ref, route);
    fixture.detectChanges();
    await fixture.whenStable();
    expectEditorBounds(editor);
  });
});
