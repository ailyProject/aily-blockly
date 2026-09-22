import * as Blockly from 'blockly/core';
import { FieldImagePreview } from '../../../editors/blockly-editor/components/blockly/custom-field/field-image-preview';
import { cacheProjectDataImage, prepareProjectDataImage, installProjectDataImageCache,
  prepareNativeProjectDataFields, registerNativeFieldPreparation, type AilyDataRef } from '@domain/project/project-data/public-api';

describe('field-owned derived image preparation', () => {
  let workspace: Blockly.Workspace;
  const ref = (key: string): AilyDataRef => ({ $ailyData: { schemaVersion: 1, id: `sha256:${key.repeat(64)}`,
    codec: 'image-original-v1', logicalType: 'binary', storage: 'raw-v1', rawLength: 3, storedLength: 3 } });
  const png = (color: string) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL();
  };
  const field = (resource: AilyDataRef) => {
    const block = workspace.newBlock('image_preparation_test');
    const value = block.getField('IMAGE') as FieldImagePreview;
    value.setValue({ ...value.getValue(), filePath: 'same.png', image: resource, mediaType: 'image/png' });
    return value;
  };
  beforeEach(() => {
    Blockly.Blocks['image_preparation_test'] = { init() {
      this.appendDummyInput().appendField(FieldImagePreview.fromJson({} as any), 'IMAGE');
    } };
    workspace = new Blockly.Workspace();
  });
  afterEach(() => { workspace.dispose(); delete Blockly.Blocks['image_preparation_test']; });

  it('isolates same-filename resources and workspaces, and releases disposed owners', async () => {
    const red = ref('a'), blue = ref('b'), first = field(red), second = field(blue);
    await cacheProjectDataImage(first, red, png('#ff0000'));
    await cacheProjectDataImage(second, blue, png('#0000ff'));
    const realm: any = {}, other: any = {}, empty = new Blockly.Workspace();
    try {
      installProjectDataImageCache(realm, () => workspace, () => {});
      installProjectDataImageCache(other, () => empty, () => {});
      expect(Object.keys(other.tftImageCache)).toEqual([]);
      expect(Object.keys(realm.tftImageCache).sort()).toEqual([red.$ailyData.id, blue.$ailyData.id]);
      expect(realm.tftImageCache[red.$ailyData.id].processedSizes[8]).toEqual(Array(64).fill('0xF800'));
      expect(realm.tftImageCache[blue.$ailyData.id].processedSizes[8]).toEqual(Array(64).fill('0x001F'));
      expect(Object.isFrozen(realm.tftImageCache[red.$ailyData.id].processedSizes[8])).toBeTrue();
      first.getSourceBlock()!.dispose();
      expect(Object.keys(realm.tftImageCache)).toEqual([blue.$ailyData.id]);
      second.setValue({ ...second.getValue(), image: red });
      expect(Object.keys(realm.tftImageCache)).toEqual([]);
    } finally { empty.dispose(); }
  });

  it('rejects an owner or resource changed while decoding, and stale runtime access', async () => {
    const resource = ref('a'), value = field(resource), data = png('#ff0000');
    const pending = cacheProjectDataImage(value, resource, data);
    value.setValue({ ...value.getValue(), image: ref('b') });
    await expectAsync(pending).toBeRejectedWithError(/changed during preparation/);
    const disposed = field(resource), pendingDisposed = cacheProjectDataImage(disposed, resource, data);
    disposed.getSourceBlock()!.dispose();
    await expectAsync(pendingDisposed).toBeRejectedWithError(/changed during preparation/);
    const realm: any = {};
    installProjectDataImageCache(realm, () => workspace, () => { throw Error('stale runtime'); });
    expect(() => realm.tftImageCache).toThrowError('stale runtime');
  });

  it('rejects external URLs and snapshot length mismatches', async () => {
    const resource = ref('a'), value = field(resource);
    await expectAsync(cacheProjectDataImage(value, resource, 'file:///image.png')).toBeRejectedWithError(/inline resource bytes/);
    await expectAsync(prepareProjectDataImage(value, () => new Uint8Array(2))).toBeRejectedWithError(/length mismatch/);
  });

  it('times out a decoder that never signals completion without publishing a partial cache', async () => {
    const resource = ref('a'), value = field(resource), realm: any = {};
    const data = png('#ff0000');
    spyOnProperty(HTMLImageElement.prototype, 'src', 'set').and.stub();
    installProjectDataImageCache(realm, () => workspace, () => {});
    await expectAsync(cacheProjectDataImage(value, resource, data)).toBeRejectedWithError(/decoding timed out/);
    expect(Object.keys(realm.tftImageCache)).toEqual([]);
  }, 10000);

  it('does not mistake a retained preview URL for a successfully prepared cache', async () => {
    const resource = ref('a'), value = field(resource) as any;
    value.resolvedImageRefId = resource.$ailyData.id;
    value.resolvedImageData = 'data:image/png;base64,AQID';
    await expectAsync(value.prepareForCodeGeneration()).toBeRejectedWithError(/decoding failed/);
  });

  it('checks lifecycle on both sides of trusted preparation and rejects changed hooks', async () => {
    const value = field(ref('a')) as any, original = () => {};
    value.prepareForCodeGeneration = original;
    let current = true;
    registerNativeFieldPreparation(value, async () => { current = false; });
    await expectAsync(prepareNativeProjectDataFields(workspace, () => null, () => {
      if (!current) throw Error('expired');
    })).toBeRejectedWithError('expired');
    value.getSourceBlock().dispose();
    const replacement = field(ref('b')) as any;
    replacement.prepareForCodeGeneration = () => {};
    registerNativeFieldPreparation(replacement, async () => { replacement.prepareForCodeGeneration = () => {}; });
    await expectAsync(prepareNativeProjectDataFields(workspace, () => null, () => {})).toBeRejectedWithError(/changed during execution/);
  });
});
