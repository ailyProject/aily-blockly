export interface ChatRuntimeOwnerScheduler {
  run<T>(operation: () => T): T;
  runOutsideOwner<T>(operation: () => Promise<T> | T): Promise<T> | T;
  yieldToIdle(timeoutMs?: number): Promise<void>;
  yieldToTask(delayMs?: number): Promise<void>;
}
