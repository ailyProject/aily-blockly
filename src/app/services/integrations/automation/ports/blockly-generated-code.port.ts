import { InjectionToken } from '@angular/core';

export interface BlocklyGeneratedCodePort {
  getReusableGeneratedCode(): string;
}

export const BLOCKLY_GENERATED_CODE_PORT = new InjectionToken<BlocklyGeneratedCodePort>(
  'BLOCKLY_GENERATED_CODE_PORT',
);
