/**
 * Aily Chat Plugin — Angular DI Token
 *
 * 宿主 IDE 通过此 Token 注入 IAilyHostAPI 实现：
 *
 *   providers: [
 *     { provide: AILY_HOST_TOKEN, useClass: BlocklyHostAdapter }
 *   ]
 */

import { InjectionToken } from '@angular/core';
import { IAilyHostAPI } from './host-api';

export const AILY_HOST_TOKEN = new InjectionToken<IAilyHostAPI>('IAilyHostAPI');
