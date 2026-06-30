import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'aily-chat-debug-breadcrumb',
  standalone: true,
  imports: [CommonModule],
  template: `
    <nav class="chat-debug-breadcrumb" aria-label="导入调试导航">
      <button type="button" class="chat-debug-breadcrumb-item" (click)="homeRequested.emit()">{{ homeLabel }}</button>
      <span class="chat-debug-breadcrumb-separator" aria-hidden="true">›</span>
      @if (currentLabel) {
      <button type="button" class="chat-debug-breadcrumb-item" (click)="overviewRequested.emit()">{{ sessionTitle }}</button>
      <span class="chat-debug-breadcrumb-separator" aria-hidden="true">›</span>
      <span class="chat-debug-breadcrumb-current">{{ currentLabel }}</span>
      } @else {
      <span class="chat-debug-breadcrumb-current">{{ sessionTitle }}</span>
      }
    </nav>
  `,
  styles: [`
    :host {
      display: block;
      margin-bottom: 12px;
    }

    .chat-debug-breadcrumb {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
      line-height: 1.4;
      color: var(--aily-text-muted, rgba(255, 255, 255, 0.68));
    }

    .chat-debug-breadcrumb-item {
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .chat-debug-breadcrumb-item:hover {
      color: var(--aily-text-primary, #fff);
      text-decoration: underline;
    }

    .chat-debug-breadcrumb-current {
      color: var(--aily-text-primary, #fff);
      font-weight: 600;
    }

    .chat-debug-breadcrumb-separator {
      opacity: 0.72;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatDebugBreadcrumbComponent {
  @Input({ required: true }) sessionTitle = '';
  @Input() currentLabel: string | null = null;
  @Output() homeRequested = new EventEmitter<void>();
  @Output() overviewRequested = new EventEmitter<void>();

  readonly homeLabel = '导入的调试快照';
}
