import {
  Component,
  Input,
  ChangeDetectionStrategy,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AnimationConfig } from '../../interfaces';

@Component({
  selector: 'x-animation-text',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span *ngFor="let chunk of chunks; trackBy: trackByIndex"
          [style.animation]="animationStyle"
          [style.color]="'inherit'">{{ chunk }}</span>
  `,
  styles: [`
    :host { display: contents; }
  `]
})
export class AnimationTextComponent implements OnChanges {
  @Input() text: string = '';
  @Input() animationConfig?: AnimationConfig;

  chunks: string[] = [];
  animationStyle: string = '';
  private prevText: string = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['animationConfig'] || !this.animationStyle) {
      const fadeDuration = this.animationConfig?.fadeDuration ?? 200;
      const easing = this.animationConfig?.easing ?? 'ease-in-out';
      this.animationStyle = `x-markdown-fade-in ${fadeDuration}ms ${easing} forwards`;
    }

    if (changes['text']) {
      this.updateChunks();
    }
  }

  private updateChunks(): void {
    if (this.text === this.prevText) return;

    if (!(this.prevText && this.text.indexOf(this.prevText) === 0)) {
      this.chunks = [this.text];
      this.prevText = this.text;
      return;
    }

    const newText = this.text.slice(this.prevText.length);
    if (!newText) return;

    this.chunks = [...this.chunks, newText];
    this.prevText = this.text;
  }

  trackByIndex(index: number): number {
    return index;
  }
}
