import { AbsBaselineStore, absBaselineKey } from '../../src/app/integrations/blockly/abs/abs-baseline-store';
import { openAbsHostStorage } from '../../src/app/integrations/blockly/abs/abs-host-storage';
import { absJson, createAbsProjection, hashAbsText } from '../../src/app/integrations/blockly/abs/abs-identity-map';

/** Test setup only: publish a valid historical generation through the production
 * journal. Never forge a map/pointer hash or use this as Agent recovery evidence. */
export async function seedUnmarkedGeneration(project: string) {
  if (!/\/aily-project\/dev-tests\/.*\/serial-agent-[^/]+\/project$/i.test(project.replaceAll('\\', '/'))) {
    throw new Error('Only a fresh acceptance project can be seeded');
  }
  const port = await openAbsHostStorage(project, () => {});
  const expected = await port.read('project.abs.map.json');
  if (!expected) throw new Error('An actual Agent export must establish the fixture first');
  const scope = JSON.parse(expected).scope;
  if (scope.projectKey !== project) throw new Error('Refuse a copied project scope');
  const store = new AbsBaselineStore(port, scope), committed = await store.inspectCommitted();
  if (!committed) throw new Error('Missing committed fixture');
  const previous = committed.projection;
  const document: any = JSON.parse(absJson(previous.document));
  const oldAbi = await store.readDerivedAbi(previous.map.generation);
  if (!oldAbi || !Object.hasOwn(JSON.parse(oldAbi), '$ailyProjectData')) throw new Error('Expected marked saved ABI');
  const abi = JSON.parse(oldAbi);
  delete document.$ailyProjectData;
  delete abi.$ailyProjectData;
  const abiText = JSON.stringify(abi), generation = crypto.randomUUID();
  const projection = await createAbsProjection(previous.workspace, { document, contracts: previous.contracts,
    scope, generation, baselineRef: absBaselineKey(generation), savedAbiHash: await hashAbsText(absJson(abi)) });
  const disk = await store.captureDisk();
  await store.stage({ projection, mode: 'import', abi: abiText, inputAbs: disk.abs, expected: disk }, committed.pointerHash);
  const result = await store.commit(generation, () => {}, async (text, hash, storage) => {
    if (!await storage.replace('project.abi', hash, text)) throw new Error('Fixture ABI CAS failed');
  });
  if (result.status !== 'COMMITTED' || await store.readDerivedAbi(generation) !== abiText) throw new Error('Fixture did not commit');
  return { generation, abiText, mapText: await port.read('project.abs.map.json'),
    pointerText: await port.read('committed.json'), previousGeneration: previous.map.generation };
}
