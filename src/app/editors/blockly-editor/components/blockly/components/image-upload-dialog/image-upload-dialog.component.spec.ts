import { ElementRef } from '@angular/core';
import { ImageUploadDialogComponent } from './image-upload-dialog.component';

describe('ImageUploadDialogComponent lifecycle (#738)', () => {
  let component: ImageUploadDialogComponent;
  let host: HTMLDivElement;
  let modal: any;
  let message: any;
  let converter: any;

  function imageFile(color = 'black'): File {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color; ctx.fillRect(0, 0, 256, 128);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    return new File([bytes], `${color}.png`, { type: 'image/png' });
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = performance.now() + 3000;
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(predicate()).toBeTrue();
  }

  beforeEach(() => {
    modal = { getConfig: () => ({ nzData: { request: { width: 64, height: 32 } } }),
      close: jasmine.createSpy('close'), triggerCancel: jasmine.createSpy('triggerCancel') };
    message = { error: jasmine.createSpy('error') };
    converter = { cancel: jasmine.createSpy('cancel'), convert: jasmine.createSpy('convert').and.resolveTo(''),
      getBitmap2DArray: () => [[1]] };
    component = new ImageUploadDialogComponent(modal, message, converter);
    host = document.createElement('div');
    host.style.cssText = 'width:400px;height:300px;position:relative';
    const image = document.createElement('img');
    image.style.display = 'none';
    const canvas = document.createElement('canvas');
    host.append(image, canvas); document.body.appendChild(host);
    component.cropperImage = new ElementRef(image);
    component.myCanvas = new ElementRef(canvas);
  });

  afterEach(() => { component.ngOnDestroy(); host.remove(); });

  it('keeps one ready Cropper even if the source receives another load event', async () => {
    component.handleFileSelect(imageFile());
    await waitFor(() => component.isReady);
    const cropper = component.cropper;
    component.cropperImage.nativeElement.dispatchEvent(new Event('load'));
    expect(component.cropper).toBe(cropper);
    expect((component.cropperImage.nativeElement as any).cropper).toBe(cropper);
    expect(host.querySelectorAll('.cropper-container').length).toBe(1);
    expect(component.currentCropSize).toEqual({ width: 64, height: 32 });
    expect(await component.convert2bitmap()).toBeTrue();
  });

  it('keeps only the latest image when selections overlap and cleans up on close', async () => {
    component.handleFileSelect(imageFile('black'));
    component.handleFileSelect(imageFile('white'));
    await waitFor(() => component.isReady);
    expect(host.querySelectorAll('.cropper-container').length).toBe(1);
    const data = component.cropper!.getCroppedCanvas().getContext('2d')!.getImageData(0, 0, 1, 1).data;
    expect(Array.from(data)).toEqual([255, 255, 255, 255]);
    component.onClose();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(host.querySelectorAll('.cropper-container').length).toBe(0);
    expect(component.bitmapArray).toEqual([]);
    expect(component.currentCropSize).toEqual({ width: 0, height: 0 });
    expect(converter.convert).not.toHaveBeenCalled();
  });

  it('ignores a late reader completion after a different file was selected', async () => {
    component.handleFileSelect(imageFile());
    const reader = (component as any).fileReader as FileReader;
    const lateLoad = reader.onload!;
    component.handleFileSelect(imageFile('white'));
    lateLoad.call(reader, { target: reader } as any);
    await waitFor(() => component.isReady);
    expect(component.imageUrl).not.toBeNull();
    expect(host.querySelectorAll('.cropper-container').length).toBe(1);
  });

  it('cancels a reader on destruction without recreating the Cropper', async () => {
    component.handleFileSelect(imageFile());
    component.ngOnDestroy();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(component.cropper).toBeNull();
    expect(host.querySelectorAll('.cropper-container').length).toBe(0);
    expect(message.error).not.toHaveBeenCalled();
  });

  it('recovers after an invalid image and allows selecting a valid file', async () => {
    component.handleFileSelect(new File(['invalid'], 'invalid.png', { type: 'image/png' }));
    await waitFor(() => !component.isLoading);
    expect(message.error).toHaveBeenCalledWith('图片加载失败');
    expect(component.imageUrl).toBeNull();
    component.handleFileSelect(imageFile());
    await waitFor(() => component.isReady);
    expect(await component.convert2bitmap()).toBeTrue();
  });

  it('does not draw or confirm an empty Cropper result', async () => {
    component.handleFileSelect(imageFile());
    await waitFor(() => component.isReady);
    spyOn(component.cropper!, 'getCroppedCanvas').and.returnValue(undefined as any);
    const draw = spyOn(component.myCanvas.nativeElement.getContext('2d')!, 'drawImage');
    expect(await component.convert2bitmap()).toBeFalse();
    await component.onConfirm();
    expect(draw).not.toHaveBeenCalled();
    expect(modal.close).not.toHaveBeenCalled();
    expect(component.isConfirming).toBeFalse();
  });

  it('restores the requested output size after moving, resizing and resetting', async () => {
    component.handleFileSelect(imageFile());
    await waitFor(() => component.isReady);
    component.cropper!.setCropBoxData({ width: 200, height: 160, left: 0, top: 0 });
    component.cropper!.zoom(0.5);
    component.centerCropBox();
    expect(component.currentCropSize).toEqual({ width: 64, height: 32 });
    expect(await component.convert2bitmap()).toBeTrue();
  });

  it('flushes confirmation once without a queued preview canceling it', async () => {
    component.handleFileSelect(imageFile());
    await waitFor(() => component.isReady);
    let finish!: () => void;
    converter.convert.and.callFake(() => new Promise<void>(resolve => { finish = resolve; }));
    const confirmation = component.onConfirm();
    await component.onConfirm();
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(converter.convert).toHaveBeenCalledTimes(1);
    finish(); await confirmation;
    expect(modal.close).toHaveBeenCalledOnceWith({ bitmapArray: [[1]], width: 64, height: 32, option: component.options });
  });

  it('never submits a conversion that completes after closing the dialog', async () => {
    component.handleFileSelect(imageFile());
    await waitFor(() => component.isReady);
    let finish!: () => void;
    converter.convert.and.callFake(() => new Promise<void>(resolve => { finish = resolve; }));
    const confirmation = component.onConfirm();
    component.onClose();
    finish(); await confirmation;
    expect(modal.close).not.toHaveBeenCalled();
    expect(component.bitmapArray).toEqual([]);
  });
});
