import { Component } from '@angular/core';
import { ChildToolPresentationComponent } from '../child-tool-presentation/child-tool-presentation.component';

/** Preserve the public route while sharing the normal tool presentation path. */
@Component({
  selector: 'app-simulator-route',
  standalone: true,
  imports: [ChildToolPresentationComponent],
  template: '<app-child-tool-presentation toolId="simulator"></app-child-tool-presentation>',
  styles: [':host { display: block; height: 100%; min-height: 0; }'],
})
export class SimulatorRouteComponent {}
