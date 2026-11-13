// Node-only selection of the production domain exports consumed by the pure kernel.
// The UI domain barrel also eagerly imports DOM services. Do not replace any
// resource validation/serialization function with a stub to avoid that import.
export * from '../../../src/app/services/domains/project/project-document-json';
export * from '../../../src/app/services/domains/project/project-data/project-data-policy';
export * from '../../../src/app/services/domains/project/project-data/project-data-generic-values';
export * from '../../../src/app/services/domains/project/project-data/project-data-codec.registry';
export * from '../../../src/app/services/domains/project/project-data/project-data-runtime';
export * from '../../../src/app/services/domains/project/project-data/project-data.types';
