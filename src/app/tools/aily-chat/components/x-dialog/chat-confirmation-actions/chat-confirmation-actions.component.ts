import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateService } from '@ngx-translate/core';

export interface ChatConfirmationActionOption {
  value: string;
  label: string;
  tooltip?: string;
  disabled?: boolean;
  isSecondary?: boolean;
  resolveOnSelect?: boolean;
}

@Component({
  selector: 'aily-chat-confirmation-actions',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cca-actions">
      <div class="cca-split-btn">
        <button
          type="button"
          class="cca-btn-primary"
          [class.cca-btn-primary-standalone]="!hasMoreActions"
          [title]="effectivePrimaryTooltip"
          [disabled]="primaryDisabled"
          (click)="approve.emit(primaryValue)"
        >{{ effectivePrimaryLabel }}</button>
        @if (hasMoreActions) {
          <button type="button" class="cca-btn-caret" #caretBtn [title]="effectiveMoreActionsTooltip" (click)="toggleDropdown($event)">
            <i class="fa-solid fa-chevron-down"></i>
          </button>
        }
        @if (dropdownOpen && hasMoreActions) {
          <div class="cca-dropdown" role="menu">
            @for (option of options; track option.value) {
              <button
                type="button"
                class="cca-dropdown-item"
                [class.cca-dropdown-item-secondary]="option.isSecondary"
                [disabled]="!!option.disabled"
                [title]="option.tooltip || option.label"
                (click)="selectOption(option)"
              >{{ option.label }}</button>
            }
          </div>
        }
      </div>
      <button type="button" class="cca-btn-reject" [title]="effectiveRejectTooltip" (click)="reject.emit()">{{ effectiveRejectLabel }}</button>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }
    .cca-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 0 5px;
      margin-bottom: 5px;
    }
    .cca-split-btn {
      display: flex;
      position: relative;
    }
    .cca-btn-primary {
      min-height: 22px;
      padding: 0 10px;
      border-radius: 5px 0 0 5px;
      font-size: 12px;
      font-weight: 400;
      line-height: 1.2;
      background: #0e639c;
      color: #ffffff;
      border: 1px solid transparent;
      outline: none;
      cursor: pointer;
      transition: background 0.15s;
    }
    .cca-btn-primary-standalone {
      border-radius: 5px;
    }
    .cca-btn-primary:hover { background: #1177bb; }
    .cca-btn-primary:disabled {
      background: color-mix(in srgb, #0e639c 40%, transparent);
      color: rgba(255,255,255,0.7);
      cursor: not-allowed;
    }
    .cca-btn-caret {
      min-height: 22px;
      width: 22px;
      padding: 0;
      border-radius: 0 5px 5px 0;
      font-size: 11px;
      background: #0e639c;
      color: #ffffff;
      border: 1px solid transparent;
      border-left: 1px solid rgba(255,255,255,0.2);
      outline: none;
      cursor: pointer;
      transition: background 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cca-btn-caret:hover { background: #1177bb; }
    .cca-btn-caret:disabled {
      background: color-mix(in srgb, #0e639c 40%, transparent);
      color: rgba(255,255,255,0.7);
      cursor: not-allowed;
    }
    .cca-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      background: #252526;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 9999;
      min-width: 220px;
      max-width: min(320px, calc(100vw - 24px));
      padding: 4px;
      overflow: hidden;
    }
    .cca-dropdown-item {
      display: block;
      width: 100%;
      padding: 7px 10px;
      font-size: 12px;
      color: #e5e7eb;
      background: transparent;
      border: none;
      outline: none;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
      border-radius: 5px;
      line-height: 1.35;
    }
    .cca-dropdown-item-secondary {
      color: #cbd5e1;
    }
    .cca-dropdown-item:hover { background: rgba(255,255,255,0.06); color: #e0e0e0; }
    .cca-dropdown-item:disabled {
      opacity: 0.48;
      cursor: not-allowed;
    }
    .cca-dropdown-item:disabled:hover {
      background: transparent;
      color: #e5e7eb;
    }
    .cca-btn-reject {
      min-height: 22px;
      padding: 0 10px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 400;
      background: transparent;
      color: var(--chat-fg-dim, #8e8e8e);
      border: 1px solid rgba(255,255,255,0.08);
      outline: none;
      cursor: pointer;
      transition: all 0.15s;
    }
    .cca-btn-reject:hover { color: var(--chat-fg, #cccccc); border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.03); }
  `],
})
export class ChatConfirmationActionsComponent {
  private readonly translate = inject(TranslateService);

  @Input() primaryLabel = '';
  @Input() primaryValue = 'once';
  @Input() primaryTooltip = '';
  @Input() primaryDisabled = false;
  @Input() moreActionsTooltip = '';
  @Input() rejectLabel = '';
  @Input() rejectTooltip = '';
  @Input() options: readonly ChatConfirmationActionOption[] = [];

  @Output() approve = new EventEmitter<string>();
  @Output() action = new EventEmitter<string>();
  @Output() reject = new EventEmitter<void>();

  dropdownOpen = false;

  constructor(private cdr: ChangeDetectorRef, private elRef: ElementRef) {}

  get hasMoreActions(): boolean {
    return this.options.length > 0;
  }

  get effectivePrimaryLabel(): string {
    return this.primaryLabel || this.translate.instant('AILY_CHAT.PROCESS_APPROVAL_ALLOW');
  }

  get effectivePrimaryTooltip(): string {
    return this.primaryTooltip
      || this.translate.instant('AILY_CHAT.PROCESS_APPROVAL_ALLOW_ONCE_TOOLTIP');
  }

  get effectiveMoreActionsTooltip(): string {
    return this.moreActionsTooltip
      || this.translate.instant('AILY_CHAT.PROCESS_APPROVAL_MORE_OPTIONS_TOOLTIP');
  }

  get effectiveRejectLabel(): string {
    return this.rejectLabel || this.translate.instant('AILY_CHAT.PROCESS_APPROVAL_REJECT');
  }

  get effectiveRejectTooltip(): string {
    return this.rejectTooltip
      || this.translate.instant('AILY_CHAT.PROCESS_APPROVAL_REJECT_TOOLTIP');
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.dropdownOpen && !this.elRef.nativeElement.contains(event.target)) {
      this.dropdownOpen = false;
      this.cdr.markForCheck();
    }
  }

  toggleDropdown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dropdownOpen = !this.dropdownOpen;
    this.cdr.markForCheck();
  }

  selectOption(option: ChatConfirmationActionOption): void {
    if (option.disabled) {
      return;
    }

    this.dropdownOpen = false;
    this.cdr.markForCheck();
    if (option.resolveOnSelect === false) {
      this.action.emit(option.value);
      return;
    }
    this.approve.emit(option.value);
  }
}
