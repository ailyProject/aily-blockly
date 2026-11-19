import { AbsBackgroundComputation } from './abs-background';
import type { AbsSyncStoragePort } from './abs-baseline-store';

it('retains the native publication lock until dispatched I/O settles after worker failure', async () => {
  let locked = false, finish!: (value: boolean) => void;
  const replies: any[] = [];
  const worker: any = { terminate: jasmine.createSpy('terminate'), postMessage: message => {
    if (message.type === 'call') queueMicrotask(() => worker.onmessage({ data: { type: 'result', id: message.id } }));
    else replies.push(message);
  } };
  const port: AbsSyncStoragePort = { read: async () => null, withLock: async operation => {
    locked = true;
    try { return await operation({ read: async () => null, replace: () => new Promise(resolve => { finish = resolve; }) }); }
    finally { locked = false; }
  } };
  const computation = new AbsBackgroundComputation(port, { projectKey: 'project', pageId: 'main' }, () => {}, worker);
  const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
  await flush();
  worker.onmessage({ data: { type: 'io', id: 100, method: 'lock', args: [] } }); await flush();
  const lock = replies.find(message => message.id === 100).value;
  worker.onmessage({ data: { type: 'io', id: 101, method: 'replace', args: ['baselines/g1.json', null, 'candidate', lock] } });
  await flush(); computation.dispose();
  expect(worker.terminate).toHaveBeenCalled(); expect(locked).toBeTrue();
  finish(true); await flush();
  expect(locked).toBeFalse(); expect(replies.some(message => message.id === 101)).toBeFalse();
});
