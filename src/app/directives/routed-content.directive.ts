import {Directive, EmbeddedViewRef, inject, Renderer2, ViewContainerRef} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {RouterOutlet} from '@angular/router';
import {merge} from 'rxjs';

/** Size routed hosts without a sibling wildcard invalidating their SVG trees. */
@Directive({selector: 'router-outlet[ailyRoutedContent]'})
export class RoutedContentDirective {
  constructor() {
    const outlet = inject(RouterOutlet, {self: true});
    const container = inject(ViewContainerRef);
    const renderer = inject(Renderer2);
    merge(outlet.activateEvents, outlet.attachEvents)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        // RouterOutlet appends the activated/attached view to this container.
        // The previous host can still be the next DOM sibling while Angular
        // removes its animations, so size the new view rather than that sibling.
        const view = container.get(container.length - 1) as EmbeddedViewRef<unknown> | null;
        const host = view?.rootNodes.find(node => node instanceof HTMLElement);
        if (host) renderer.addClass(host, 'aily-routed-content');
      });
  }
}
