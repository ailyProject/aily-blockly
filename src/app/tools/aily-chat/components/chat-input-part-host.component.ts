import { ChangeDetectionStrategy, Component, ContentChild, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

import { FloatingTodoComponent } from './floating-todo/floating-todo.component';

@Component({
  selector: 'aily-chat-input-part-host',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'class': 'interactive-input-part',
    '(keydown)': 'onHostKeyDown($event)',
  },
  template: `
    <ng-content select="[inputPartWidget]"></ng-content>

    <ng-content></ng-content>
  `,
  styles: [`
    :host {
      width: 100%;
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 0;
      min-height: 0;
      position: relative;
    }

    .chat-question-carousel-widget-container,
    .chat-tool-confirmation-carousel-container,
    .chat-plan-review-widget-container {
      width: 100%;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      min-width: 0;
      padding: 0 10px;
      box-sizing: border-box;
    }
  `],
})
export class ChatInputPartHostComponent {
  @Input() sessionId = '';
  @Output() todoFocusToggleRequested = new EventEmitter<void>();

  @ContentChild(FloatingTodoComponent, { descendants: true }) private floatingTodo?: FloatingTodoComponent;

  hasVisibleTodos(): boolean {
    return !!this.floatingTodo && this.floatingTodo.todoList.length > 0;
  }

  isTodoListFocused(): boolean {
    return this.floatingTodo?.hasFocus() ?? false;
  }

  focusTodoList(): boolean {
    return this.floatingTodo?.focus() ?? false;
  }

  onHostKeyDown(event: KeyboardEvent): void {
    if (!isToggleTodosShortcut(event) || !canTargetToggleTodosShortcut(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.todoFocusToggleRequested.emit();
  }
}

function isToggleTodosShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey)
    && event.shiftKey
    && !event.altKey
    && event.key.toLowerCase() === 't';
}

function canTargetToggleTodosShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest('.chat-todo-list-widget, .chat-todo-list-widget-container')) {
    return true;
  }

  return !!target.closest('textarea, input, [contenteditable="true"], [contenteditable=""]');
}