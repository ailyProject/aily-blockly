// This fixture bundles only the real framework-independent public functions
// needed by the production projection kernel, not a second Angular runtime.
// No storage, transaction, hash or validation implementation is substituted.
export { assertNoOversizedInlineValues } from '../../src/app/services/domains/project/project-data/project-data-policy';
export { canonicalJsonStringify } from '../../src/app/services/domains/project/project-data/project-data-codec.registry';
export { canonicalProjectJsonStringify, cloneBlocklyJson } from '../../src/app/services/domains/project/project-document-json';
