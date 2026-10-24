import { restoreAbsProjectCaches } from './abs-project-open';
import { AbsBaselineStore, absBaselineKey } from './abs-baseline-store';
import { createAbsProjection, hashAbsText, absJson } from './abs-identity-map';

describe('complete ABS cache restoration',()=>{
 let files:Map<string,string>,port:any,store:AbsBaselineStore;
 const scope={projectKey:'project',pageId:'main'};
 beforeEach(()=>{files=new Map();port={read:async(k:string)=>files.get(k)??null,withLock:async(fn:any)=>fn({read:port.read,replace:async(k:string,h:string|null,v:string|null)=>{
 const old=files.get(k)??null;if((old===null?null:await hashAbsText(old))!==h)return false;
 if(v===null)files.delete(k);else files.set(k,v);return true;
 }})};store=new AbsBaselineStore(port,scope);});
 const save=async(text:string)=>{
 const workspace={blocks:{blocks:[{id:'setup',type:'root',deletable:false,fields:{TEXT:text},icons:{comment:{text:'kept'}}}]}};
 const document={activePageId:'main',pages:[{id:'main',content:workspace}],sharedModel:{procedureBlocks:[]}};
 const abi=JSON.stringify(document),generation=crypto.randomUUID();
 const projection=await createAbsProjection(workspace,{document,generation,baselineRef:absBaselineKey(generation),scope,savedAbiHash:await hashAbsText(absJson(document))});
 await store.stage({projection,mode:'import',inputAbs:files.get('project.abs')??projection.abs,abi,expected:await store.captureDisk()});
 await store.commit(generation,()=>{},async(t,h,s)=>{if(!await s.replace('project.abi',h,t))throw Error('CAS');});
 return {projection,abi};
 };
 it('regenerates deleted ABI/map exactly from the sole ABS snapshot',async()=>{
 const base=await save('one'),snapshot=files.get('project.abs');files.delete('project.abi');files.delete('project.abs.map.json');
 expect(await restoreAbsProjectCaches(port,'project',()=>{})).toBe(base.abi);
 expect(files.get('project.abs')).toBe(snapshot);expect(files.get('project.abs.map.json')).toBe(absJson(base.projection.map));
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
 it('restores an earlier complete ABS with a new derived generation',async()=>{
 const first=await save('one');await save('two');files.set('project.abs',first.projection.abs);
 const abi=await restoreAbsProjectCaches(port,'project',()=>{});
 expect(JSON.parse(abi!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('one');
 expect((await store.loadCommitted())!.abs).toBe(first.projection.abs);
 expect(JSON.parse(abi!).pages[0].content.blocks.blocks[0].deletable).toBeFalse();
 });
});
