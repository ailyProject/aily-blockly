// Bundle the actual kernel, not a second implementation of its identity or recovery protocol.
import '@angular/compiler';
import 'zone.js';
export { AbsBaselineStore, absBaselineKey } from '../../src/app/integrations/blockly/abs/abs-baseline-store';
export { absJson, createAbsProjection, hashAbsText } from '../../src/app/integrations/blockly/abs/abs-identity-map';
export { reconcileAbs } from '../../src/app/integrations/blockly/abs/abs-reconciler';
export { openAbsHostStorage } from '../../src/app/integrations/blockly/abs/abs-host-storage';
