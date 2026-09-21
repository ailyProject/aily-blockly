/** Framework-independent field boundary. Does not import the project/UI services. */
export { projectDataRuntime } from './project-data-runtime';
export { isAilyDataRef } from './project-data.types';
export type { AilyDataRef } from './project-data.types';
export { canonicalJsonStringify } from './project-data-codec.registry';
export { materializeProjectDataPayload, materializePreparedProjectDataPayload } from './project-data-generic-values';
export { collectProjectBlocks } from './project-data-payloads';
export { collectProjectDataReferences, projectDataFieldReference } from './project-data-references';
export { registerProjectDataBlockDefinition, wrapProjectDataGeneratorFunctions } from './blockly-project-data-adapter';
export { registerNativeFieldPreparation, prepareNativeProjectDataFields } from './project-data-field-preparation';
export type { PreparedDataReader } from './project-data-field-preparation';
export { cacheProjectDataImage, prepareProjectDataImage, installProjectDataImageCache, releaseProjectDataImage } from './project-data-image-cache';
