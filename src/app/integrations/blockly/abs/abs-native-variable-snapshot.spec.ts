import * as Blockly from 'blockly';
import { NativeUiTasks, nativeUiSemanticSnapshot } from '../../../editors/blockly-editor/services/blockly-native-ui-tasks';
import { nativeSemanticChange } from '../../../editors/blockly-editor/services/blockly-native-semantic-diagnostic';

describe('native variable declaration snapshot', () => {
  const baseline = () => [{ id: 'FUNC', name: 'fan', type: 'FUNC', metadata: { flags: [1, 2] } },
    { id: 'PID', name: 'pid', type: 'PID' }];
  it('compares complete records by ID without changing serializer order or persistence', () => {
    const workspace = new Blockly.Workspace(); let models = baseline();
    const save = spyOn(Blockly.serialization.workspaces, 'save').and.callFake(() => ({ blocks: { blocks: [] }, variables: models }));
    try {
      const tasks = new NativeUiTasks(), original = JSON.stringify(models);
      tasks.set(() => { models = [models[1], models[0]]; });
      expect(() => tasks.drain(() => nativeUiSemanticSnapshot(Blockly, workspace))).not.toThrow();
      expect(JSON.stringify(models)).not.toBe(original);
      expect(save.calls.count()).toBe(2);
      expect(models[0].id).toBe('PID');
    } finally { workspace.dispose(); }
  });
  for (const change of ['add', 'delete', 'rename', 'type', 'id', 'metadata', 'duplicate'])
  it('does not hide a real model change: ' + change, () => {
    const workspace = new Blockly.Workspace(); let models: any[] = baseline();
    spyOn(Blockly.serialization.workspaces, 'save').and.callFake(() => ({ blocks: { blocks: [] }, variables: models }));
    try {
      const tasks = new NativeUiTasks();
      tasks.set(() => {
        models = JSON.parse(JSON.stringify(models));
        if (change === 'add') models.push({ id: 'new', name: 'new', type: '' });
        else if (change === 'delete') models.pop();
        else if (change === 'duplicate') models.push({ ...models[0] });
        else if (change === 'metadata') models[0].metadata.flags.reverse();
        else if (change === 'rename') models[0].name = 'changed';
        else models[0][change] = 'changed';
      });
      expect(() => tasks.drain(() => nativeUiSemanticSnapshot(Blockly, workspace)))
        .toThrowError(/changed persisted state/);
    } finally { workspace.dispose(); }
  });
  it('does not mistake a typed variable or an extraState payload for a Blockly block', () => {
    const variable = (id: string) => JSON.stringify({ state: { variables: [{ id, name: 'pid', type: 'PID' }] }, shapes: [] });
    const failure = nativeSemanticChange(variable('before'), variable('after'), 'initialization');
    expect(failure.diagnostic!.modelName).toBe('pid');
    expect(failure.diagnostic!.blockId).toBeUndefined(); expect(failure.diagnostic!.blockType).toBeUndefined();
    const block = (n: number) => JSON.stringify({ state: { blocks: { blocks: [{ id: 'owner', type: 'block',
      extraState: { id: 'not-a-block', type: 'payload', n } }] } }, shapes: [] });
    expect(nativeSemanticChange(block(1), block(2), 'ui').diagnostic!.blockId).toBe('owner');
  });
});
