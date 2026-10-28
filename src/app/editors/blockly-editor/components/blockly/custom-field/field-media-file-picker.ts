/** A native file dialog temporarily moves focus outside the document. Blockly
 * 13 treats that focusout as dismissal and would dispose the field's change
 * listener before the selected file arrives. Scope the exception to this
 * editor, a pending picker, and focus transitions without a DOM destination. */
export class MediaFieldFilePicker {
  private pending = false;
  private disposed = false;

  private readonly onFocusOut = (event: FocusEvent) => {
    if (this.pending && event.relatedTarget === null) event.stopPropagation();
  };
  private readonly onSettled = () => { this.pending = false; };

  constructor(private readonly editor: HTMLElement, private readonly input: HTMLInputElement) {
    editor.addEventListener('focusout', this.onFocusOut);
    input.addEventListener('change', this.onSettled);
    input.addEventListener('cancel', this.onSettled);
  }

  open(): void {
    if (this.disposed || this.pending) return;
    this.pending = true;
    try { this.input.click(); }
    catch (error) { this.pending = false; throw error; }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    this.editor.removeEventListener('focusout', this.onFocusOut);
    this.input.removeEventListener('change', this.onSettled);
    this.input.removeEventListener('cancel', this.onSettled);
  }
}
