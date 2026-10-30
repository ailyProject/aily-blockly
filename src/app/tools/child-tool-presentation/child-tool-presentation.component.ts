import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectorRef, Component, Input, type OnChanges, type OnDestroy, type SimpleChanges, type Type, inject } from '@angular/core';
import {
  CHILD_TOOL_NATIVE_PRESENTATION, CHILD_TOOL_PRESENTATION_PLATFORM, CHILD_TOOL_PRESENTATION_OVERRIDES, CHILD_TOOL_WEB_PRESENTATIONS,
  type ChildToolWebPresentation,
} from './child-tool-presentation.providers';

/** Selects a trusted presentation only; runtime ownership stays in its original
 * component. Changing focus forwards inputs without recreating that component. */
@Component({
  selector: 'app-child-tool-presentation',
  standalone: true,
  imports: [NgComponentOutlet],
  template: '<div role="status">{{ status }}</div><ng-container *ngComponentOutlet="component; inputs: inputs"></ng-container>',
  styles: [':host { display: block; width: 100%; height: 100%; min-height: 0; }'],
})
export class ChildToolPresentationComponent implements OnChanges, OnDestroy {
  @Input() toolId = '';
  @Input() active = true;
  @Input() presentationId = '';

  component: Type<unknown> | null = null;
  inputs: Record<string, unknown> = {};
  status = '';
  private readonly platform = inject(CHILD_TOOL_PRESENTATION_PLATFORM);
  private readonly overrides = inject(CHILD_TOOL_PRESENTATION_OVERRIDES);
  private readonly native = inject(CHILD_TOOL_NATIVE_PRESENTATION);
  private readonly web = inject(CHILD_TOOL_WEB_PRESENTATIONS);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private presentation: ChildToolWebPresentation | null = null;
  private generation = 0;
  private destroyed = false;

  private selectedPlatform(): 'native' | 'web' {
    return Object.hasOwn(this.overrides, this.toolId) ? this.overrides[this.toolId] : this.platform;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['toolId']) this.select();
    else if (changes['active'] || changes['presentationId']) this.updateInputs();
  }

  ngOnDestroy(): void { this.destroyed = true; this.generation++; }

  private updateInputs(): void {
    this.inputs = this.selectedPlatform() === 'native' ? { toolId: this.toolId, active: this.active,
      ...(this.presentationId ? { presentationId: this.presentationId } : {}) }
      : this.presentation?.inputs?.({ toolId: this.toolId, active: this.active }) ?? {};
  }

  private select(): void {
    const generation = ++this.generation;
    this.component = null;
    const platform = this.selectedPlatform();
    this.presentation = platform === 'web' && Object.hasOwn(this.web, this.toolId)
      ? this.web[this.toolId] : null;
    const presentation = this.presentation;
    const load = platform === 'native' ? this.native
      : presentation && typeof presentation.load === 'function' ? () => presentation.load() : null;
    this.updateInputs();
    this.status = load ? 'Tool interface loading.' : 'Tool interface is unavailable.';
    if (!load) return;
    void Promise.resolve().then(load).then(component => {
      if (this.destroyed || generation !== this.generation) return;
      this.component = component;
      this.status = '';
      this.changeDetector.markForCheck();
    }, () => {
      if (!this.destroyed && generation === this.generation) {
        this.status = 'Tool interface failed to load.';
        this.changeDetector.markForCheck();
      }
    });
  }
}
