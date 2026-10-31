import { InjectionToken } from '@angular/core';

/** The application composition connects an existing portable generation to its
 * coordinator. The editor does not depend on the ABS integration or acquire a
 * second workspace lease inside an owned generation transaction. */
export interface BlocklyPortableProjectSave {
  save(path: string): Promise<void>;
}

export const BLOCKLY_PORTABLE_PROJECT_SAVE = new InjectionToken<BlocklyPortableProjectSave>('BLOCKLY_PORTABLE_PROJECT_SAVE');
