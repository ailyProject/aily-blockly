import * as Blockly from 'blockly';
import { MediaFieldFilePicker } from './field-media-file-picker';
import { FieldU8g2Animation } from './field-u8g2-animation';
import { FieldTftEsPiAnimation } from './field-tftespi-animation';
import { FieldAudio } from './field-audio';
import { FieldImagePreview } from './field-image-preview';

describe('native media file picker focus lifetime', () => {
  let root: HTMLDivElement, editor: HTMLDivElement, input: HTMLInputElement;
  let picker: MediaFieldFilePicker, outside: jasmine.Spy;
  const blur = (target: EventTarget | null = null) => editor.dispatchEvent(
    new FocusEvent('focusout', { bubbles: true, relatedTarget: target }));
  beforeEach(() => {
    root = document.createElement('div'); editor = document.createElement('div');
    input = document.createElement('input'); input.type = 'file';
    root.append(editor); editor.append(input); document.body.append(root);
    outside = jasmine.createSpy('outer focusout'); root.addEventListener('focusout', outside);
    picker = new MediaFieldFilePicker(editor, input);
    spyOn(input, 'click').and.callFake(() => { blur(); });
  });
  afterEach(() => { picker.dispose(); root.remove(); });

  it('protects only the pending native picker focus transition', () => {
    blur(); expect(outside).toHaveBeenCalledTimes(1);
    picker.open(); expect(outside).toHaveBeenCalledTimes(1);
    blur(document.body); expect(outside).toHaveBeenCalledTimes(2);
    root.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(outside).toHaveBeenCalledTimes(3);
  });
  for (const event of ['change', 'cancel']) it(`releases protection after ${event} and permits another picker`, () => {
    picker.open(); picker.open(); expect(input.click).toHaveBeenCalledTimes(1);
    input.dispatchEvent(new Event(event)); blur(); expect(outside).toHaveBeenCalledTimes(1);
    picker.open(); expect(input.click).toHaveBeenCalledTimes(2);
    expect(outside).toHaveBeenCalledTimes(1);
  });
  it('releases protection when opening throws', () => {
    (input.click as jasmine.Spy).and.throwError('picker unavailable');
    expect(() => picker.open()).toThrowError('picker unavailable');
    blur(); expect(outside).toHaveBeenCalledTimes(1);
  });
  it('removes listeners on disposal, including a pending picker', () => {
    picker.open(); picker.dispose(); picker.dispose(); blur(); picker.open();
    expect(outside).toHaveBeenCalledTimes(1); expect(input.click).toHaveBeenCalledTimes(1);
  });
});

describe('media fields with real Blockly 13 popover focus management', () => {
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg;
  const fields = [
    { name: 'U8g2 animation', create: () => FieldU8g2Animation.fromJson({}), handler: 'onFileSelected' },
    { name: 'TFT animation', create: () => FieldTftEsPiAnimation.fromJson({}), handler: 'onFileSelected' },
    { name: 'TFT image', create: () => FieldTftEsPiAnimation.fromJson({ imageMode: true }), handler: 'onFileSelected' },
    { name: 'audio', create: () => FieldAudio.fromJson({}), handler: 'handleSelectedFile' },
    { name: 'image preview', create: () => new FieldImagePreview(Blockly.Field.SKIP_SETUP), handler: 'handleFileSelected' },
  ];
  beforeEach(() => {
    host = document.createElement('div'); host.style.cssText = 'width:1000px;height:700px';
    document.body.append(host); workspace = Blockly.inject(host, { sounds: false });
  });
  afterEach(() => {
    Blockly.DropDownDiv.hideWithoutAnimation(); workspace.dispose(); host.remove();
    delete Blockly.Blocks['media_picker_probe'];
  });
  async function open(entry: typeof fields[number]) {
    const field: any = entry.create();
    const selected = spyOn(field, entry.handler).and.returnValue(Promise.resolve());
    Blockly.Blocks['media_picker_probe'] = { init() { this.appendDummyInput().appendField(field, 'MEDIA'); } };
    const block = workspace.newBlock('media_picker_probe'); block.initSvg(); block.render();
    await Blockly.renderManagement.finishQueuedRenders();
    field.showEditor_();
    const content = Blockly.DropDownDiv.getContentDiv();
    const input = content.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input).not.toBeNull();
    const editor = input.closest('.ailyMediaFieldEditor, .imagePreviewEditor')!;
    const upload = input.parentElement!.querySelector<HTMLButtonElement>('button')
      ?? content.querySelector<HTMLButtonElement>('button')!;
    spyOn(input, 'click').and.callFake(() => {
      editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    });
    return { field, content, input, editor, upload, selected };
  }
  it('reproduces the old failure when the native picker has no focus guard', async () => {
    const { field, input } = await open(fields[0]);
    field.filePicker.dispose();
    // The onHide callback is bound already; observe its actual listener cleanup.
    const unbind = spyOn(Blockly.browserEvents, 'unbind').and.callThrough();
    input.click();
    expect(unbind).toHaveBeenCalled();
    expect(field.fileInput).toBeNull();
  });
  for (const entry of fields) {
    it(`${entry.name}: delivers the file change after native focus loss`, async () => {
      const { field, content, input, editor, upload, selected } = await open(entry);
      upload.click();
      expect(editor.isConnected).toBeTrue();
      expect(content.contains(input)).toBeTrue();
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.gif'));
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
      expect(selected).toHaveBeenCalledTimes(1);
      expect(editor.isConnected).toBeTrue();
      // Ordinary outside focus loss must still dispose the editor immediately.
      const disposed = spyOn(field.filePicker, 'dispose').and.callThrough();
      editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
      expect(disposed).toHaveBeenCalledTimes(1);
    });
    it(`${entry.name}: cancel preserves the editor, but a later ordinary blur closes it`, async () => {
      const { field, input, editor, upload } = await open(entry);
      upload.click(); input.dispatchEvent(new Event('cancel'));
      expect(editor.isConnected).toBeTrue();
      const disposed = spyOn(field.filePicker, 'dispose').and.callThrough();
      editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      expect(disposed).toHaveBeenCalledTimes(1);
    });
  }
});
