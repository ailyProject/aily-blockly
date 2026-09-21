import { NativeRegistrationTasks } from '../../../editors/blockly-editor/services/blockly-native-registration-tasks';

describe('finite native registration timers', () => {
  let tasks: NativeRegistrationTasks;
  beforeEach(() => { tasks = new NativeRegistrationTasks(window.setTimeout.bind(window), window.clearTimeout.bind(window)); });
  afterEach(() => tasks.dispose());

  it('drains nested timers and excludes cancelled callbacks before closing registration', async () => {
    const values: number[] = [];
    tasks.clear(tasks.set(() => fail('cancelled callback ran'), 1));
    tasks.set(() => { values.push(1); tasks.set(() => { values.push(2); }); });
    await tasks.drain();
    expect(values).toEqual([1, 2]);
    expect(() => tasks.set(() => {})).toThrowError(/after registration/);
    expect(() => tasks.assertClean()).toThrowError(/after registration/);
  });

  it('retains falsy failures and cancels siblings', async () => {
    tasks.set(() => { throw null; });
    tasks.set(() => fail('sibling callback ran'), 100);
    await expectAsync(tasks.drain()).toBeRejectedWith(null);
  });

  it('rejects returned promises instead of treating their callbacks as completed', async () => {
    tasks.set(() => Promise.resolve());
    await expectAsync(tasks.drain()).toBeRejectedWithError(/asynchronous registration callbacks/);
  });

  it('wakes a pending drain and cancels timers on disposal', async () => {
    tasks.set(() => fail('disposed callback ran'), 100);
    const drain = tasks.drain();
    tasks.dispose();
    await expectAsync(drain).toBeRejectedWithError(/disposed/);
  });

  it('keeps caught delay-budget violations sticky', async () => {
    try { tasks.set(() => {}, 2001); } catch {}
    await expectAsync(tasks.drain()).toBeRejectedWithError(/budget/);
  });

  it('bounds both total delay and total scheduled callbacks, including cancelled timers', async () => {
    tasks.set(() => {}, 2000); tasks.set(() => {}, 2000);
    expect(() => tasks.set(() => {}, 1001)).toThrowError(/budget/);
    await expectAsync(tasks.drain()).toBeRejectedWithError(/budget/);
    tasks.dispose();
    tasks = new NativeRegistrationTasks(window.setTimeout.bind(window), window.clearTimeout.bind(window));
    for (let i = 0; i < 128; i++) tasks.clear(tasks.set(() => {}));
    expect(() => tasks.set(() => {})).toThrowError(/budget/);
    await expectAsync(tasks.drain()).toBeRejectedWithError(/budget/);
  });
});
