// R0 tests bundle the actual pure production kernel into ignored test output.
// This entry introduces no substitute commit, recovery or receipt implementation.
export { AbsBaselineStore, absBaselineKey } from '../../../src/app/integrations/blockly/abs/abs-baseline-store';
export { AbsOperationJournal } from '../../../src/app/integrations/blockly/abs/abs-operation-journal';
export { AbsApplicationJournal } from '../../../src/app/integrations/blockly/abs/abs-application-journal';
export { absJson, hashAbsText, createAbsProjection } from '../../../src/app/integrations/blockly/abs/abs-identity-map';
export { generationEvidence } from '../../../src/app/integrations/blockly/abs/abs-generation-protocol';
export { ProjectSaveReceipts } from '../../../src/app/services/domains/project/project-save-receipts';
export { composeBlocklyPage } from '../../../src/app/editors/blockly-editor/services/blockly-project-model';
