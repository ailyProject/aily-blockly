/** Framework-independent field boundary. Does not import the project/UI services. */
export { projectDataRuntime } from './project-data-runtime';
export { isAilyDataRef } from './project-data.types';
export type { AilyDataRef } from './project-data.types';
export { MAX_U8G2_BITMAP_DIMENSION, packXbmBitmap } from './project-data-xbm';
export type { U8g2BitmapValue } from './project-data-xbm';
export { DEFAULT_U8G2_BITMAP_SIZE, DEFAULT_TFT_MEDIA_SIZE, MAX_TFT_MEDIA_DIMENSION,
  u8g2BitmapSize, tftMediaSize } from './project-data-media-dimensions';
export { canonicalJsonStringify, createDefaultProjectDataCodecRegistry } from './project-data-codec.registry';
export { canonicalProjectJsonStringify } from '../project-document-json';
export { materializeProjectDataPayload, materializePreparedProjectDataPayload } from './project-data-generic-values';
export { collectProjectBlocks, collectProjectBlockLocations } from './project-data-payloads';
export { collectProjectDataReferences, projectDataFieldReference } from './project-data-references';
export { registerProjectDataBlockDefinition, wrapProjectDataGeneratorFunctions } from './blockly-project-data-adapter';
export { registerNativeFieldPreparation, prepareNativeProjectDataFields } from './project-data-field-preparation';
export type { PreparedDataReader } from './project-data-field-preparation';
export { cacheProjectDataImage, prepareProjectDataImage, installProjectDataImageCache, releaseProjectDataImage } from './project-data-image-cache';
