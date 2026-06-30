import { Injectable, NgZone, inject } from '@angular/core';

import type { ChatRuntimeOwnerScheduler } from '../core/chat-runtime-owner-scheduler';
import { yieldToBrowserIdle, yieldToBrowserTask } from '../tools/browserTaskScheduler';
import type { ChatRuntimeOwnerSchedulerPort } from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerSchedulerService implements ChatRuntimeOwnerScheduler, ChatRuntimeOwnerSchedulerPort {
  private readonly ngZone = inject(NgZone);

  run<T>(operation: () => T): T {
    return this.ngZone.run(operation);
  }

  runOutsideOwner<T>(operation: () => Promise<T> | T): Promise<T> | T {
    return this.ngZone.runOutsideAngular(operation);
  }

  yieldToIdle(timeoutMs?: number): Promise<void> {
    return Promise.resolve(this.runOutsideOwner(() => yieldToBrowserIdle(timeoutMs)));
  }

  yieldToTask(delayMs?: number): Promise<void> {
    return Promise.resolve(this.runOutsideOwner(() => yieldToBrowserTask(delayMs)));
  }
}
