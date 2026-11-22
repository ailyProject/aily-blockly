import { absMapJson } from './abs-map-json';
import { restoreAbsProjectCaches } from './abs-project-open';
import { AbsBaselineStore, absBaselineKey } from './abs-baseline-store';
import { createAbsProjection, reconstructAbsProjection, hashAbsText, absJson } from './abs-identity-map';
import { recoverAbsProjectOperation } from './abs-project-restart';
import { inspectAbsGeneration } from './abs-generation-inspection';
import { AbsOperationJournal } from './abs-operation-journal';

describe('complete ABS cache restoration',()=>{
 let files:Map<string,string>,port:any,store:AbsBaselineStore;
 const scope={projectKey:'project',pageId:'main'};
 beforeEach(()=>{files=new Map();port={read:async(k:string)=>files.get(k)??null,withLock:async(fn:any)=>fn({read:port.read,replace:async(k:string,h:string|null,v:string|null)=>{
 const old=files.get(k)??null;if((old===null?null:await hashAbsText(old))!==h)return false;
 if(v===null)files.delete(k);else files.set(k,v);return true;
 }})};store=new AbsBaselineStore(port,scope);});
 const save=async(text:string, legacy=false)=>{
 const workspace={blocks:{blocks:[{id:'setup',type:'root',deletable:false,fields:{TEXT:text},icons:{comment:{text:'kept'}}}]}};
 const document={activePageId:'main',pages:[{id:'main',content:workspace}],sharedModel:{procedureBlocks:[]}};
 const abi=JSON.stringify(document),generation=crypto.randomUUID();
 const context={document,generation,baselineRef:absBaselineKey(generation),scope,savedAbiHash:await hashAbsText(absJson(document))};
 const projection=legacy ? await reconstructAbsProjection(workspace,context,'\n# @project-state:{"version":1}')
   : await createAbsProjection(workspace,context);
 await store.stage({projection,mode:'import',inputAbs:files.get('project.abs')??projection.abs,abi,expected:await store.captureDisk()});
 await store.commit(generation,()=>{},async(t,h,s)=>{if(!await s.replace('project.abi',h,t))throw Error('CAS');});
 return {projection,abi};
 };
 it('regenerates deleted ABI/map exactly from the sole ABS snapshot',async()=>{
 const base=await save('one'),snapshot=files.get('project.abs');files.delete('project.abi');files.delete('project.abs.map.json');
 expect(await restoreAbsProjectCaches(port,'project',()=>{})).toBe(base.abi);
 expect(files.get('project.abs')).toBe(snapshot);expect(files.get('project.abs.map.json')).toBe(absMapJson(base.projection.map));
 });
 it('opens copied complete state without silently rebinding its private generation',async()=>{
 const base=await save('one'),pointer=files.get('committed.json');
 const draft=base.projection.abs.replace('TEXT="one"','TEXT="draft"');files.set('project.abs',draft);
 files.delete('project.abi');files.delete('project.abs.map.json');
 expect(await restoreAbsProjectCaches(port,'copied-project',()=>{})).toBe(base.abi);
 expect(files.get('project.abs')).toBe(draft);expect(files.get('committed.json')).toBe(pointer);
 expect(JSON.parse(files.get('project.abs.map.json')!).scope.projectKey).toBe('project');
 });
 it('still rejects external ABI edits in copied projects without writing caches',async()=>{
 await save('one');files.set('project.abi','{"external":true}');const before=[...files];
 await expectAsync(restoreAbsProjectCaches(port,'copied-project',()=>{})).toBeRejectedWith(jasmine.objectContaining({code:'ABS_DUAL_EDIT_CONFLICT'}));expect([...files]).toEqual(before);
 });
 it('rejects genuine external ABI edits without changing any files',async()=>{
 await save('one');files.set('project.abi','{"external":true}');const before=[...files];
 await expectAsync(restoreAbsProjectCaches(port,'project',()=>{})).toBeRejectedWith(jasmine.objectContaining({code:'ABS_DUAL_EDIT_CONFLICT'}));expect([...files]).toEqual(before);
 });
 it('preserves unapplied ABS drafts and restores only the committed cache',async()=>{
 const base=await save('one');const draft=base.projection.abs.replace('TEXT="one"','TEXT="draft"');files.set('project.abs',draft);files.delete('project.abi');
 expect(await restoreAbsProjectCaches(port,'project',()=>{})).toBe(base.abi);expect(files.get('project.abs')).toBe(draft);
 });
 for (const damage of ['truncated', 'duplicate', 'invalid-state']) it(`opens the committed canvas while retaining a ${damage} ABS draft`, async () => {
 const base = await save('one');
 const draft = damage === 'truncated' ? base.projection.abs.slice(0, -10)
   : damage === 'duplicate' ? base.projection.abs + '\n# @project-state:{}'
   : base.projection.abs.replace('"version":1', '"version":99');
 files.set('project.abs', draft); files.delete('project.abi');
 const pointer = files.get('committed.json');
 expect(await restoreAbsProjectCaches(port, 'project', () => {})).toBe(base.abi);
 expect(files.get('project.abs')).toBe(draft); expect(files.get('committed.json')).toBe(pointer);
 });
 it('rejects a damaged state without a committed snapshot and preserves all files', async () => {
 const base = await save('one'); files.set('project.abs', base.projection.abs.slice(0, -10));
 files.delete('committed.json'); const before = [...files];
 await expectAsync(restoreAbsProjectCaches(port, 'project', () => {})).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_STATE_INVALID' }));
 expect([...files]).toEqual(before);
 });
 it('opens the verified saved project without recreating a missing project-v1 author file or taking a writer lock', async () => {
   files.set('workspace-mode.json', absJson({ version: 1, mode: 'project-v1' }));
   const base = await save('one'); files.delete('project.abs');
   const before = [...files];
   const withLock = spyOn(port, 'withLock').and.rejectWith(new Error('a newer writer still holds the native lock'));
   expect(await recoverAbsProjectOperation(port, 'project', () => {})).toBeNull();
   expect(await restoreAbsProjectCaches(port, 'project', () => {})).toBe(base.abi);
   expect(withLock).not.toHaveBeenCalled();
   expect([...files]).toEqual(before);
 });
 it('cold-loads a completed operation under a newer writer without taking its lock', async () => {
   files.set('workspace-mode.json', absJson({ version: 1, mode: 'project-v1' }));
   const base = await save('one'), guard = () => {};
   const journal = new AbsOperationJournal(port, 'project');
   const id = await journal.begin({ kind: 'runtime-rebuild', document: JSON.parse(base.abi), disk: await store.captureDisk() }, guard);
   await journal.finish(id, guard);
   files.set('project.abs', base.projection.abs + '\n# pending author draft');
   const before = [...files];
   const withLock = spyOn(port, 'withLock').and.rejectWith(new Error('a newer writer holds the native lock'));
   expect(await recoverAbsProjectOperation(port, 'project', guard)).toBeNull();
   expect(await restoreAbsProjectCaches(port, 'project', guard)).toBe(base.abi);
   expect(withLock).not.toHaveBeenCalled();
   expect([...files]).toEqual(before);
 });
 it('keeps a missing project-v1 author protected when the saved ABI byte evidence differs', async () => {
   files.set('workspace-mode.json', absJson({ version: 1, mode: 'project-v1' }));
   const base = await save('one'); files.delete('project.abs');
   files.set('project.abi', base.abi + ' ');
   const before = [...files];
   await expectAsync(restoreAbsProjectCaches(port, 'project', () => {})).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SOURCE_MISSING' }));
   expect([...files]).toEqual(before);
 });
 it('validates a standalone preview.7 source in its original encoding and reports its loaded generation ready', async () => {
   const { projection } = await save('one', true);
   files.clear(); files.set('project.abs', projection.abs);
   const abi = await restoreAbsProjectCaches(port, 'project', () => {});
   expect(JSON.parse(abi!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('one');
   expect(files.get('project.abs')).toBe(projection.abs);
   expect((await store.loadCommitted())?.map.projectionVersion).toBe('abs-v2.preview.7');
   const diagnosis = (await inspectAbsGeneration(store, scope)).diagnostics;
   expect(diagnosis.status).toBe('ready'); expect(diagnosis.issues).toEqual([]);
 });
 it('restores an earlier complete ABS with a new derived generation',async()=>{
 const first=await save('one');await save('two');files.set('project.abs',first.projection.abs);
 const abi=await restoreAbsProjectCaches(port,'project',()=>{});
 expect(JSON.parse(abi!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('one');
 expect((await store.loadCommitted())!.abs).toBe(first.projection.abs);
 expect(JSON.parse(abi!).pages[0].content.blocks.blocks[0].deletable).toBeFalse();
 });
});
