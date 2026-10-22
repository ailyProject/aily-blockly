import { fakeAsync, tick } from '@angular/core/testing';
import { canonicalProjectJsonStringify } from '@domain/project/project-document/public-api';
import { BlocklyProjectDirtyState } from './blockly-project-dirty-state';
import { BlocklyProjectDocument } from './blockly-project-model';

const fixture = (): BlocklyProjectDocument => ({schemaVersion:3,activePageId:'one',openedPageIds:['one'],sharedModel:{procedureBlocks:[]},pages:[
  {id:'one',title:'One',content:{blocks:{blocks:[{id:'a',type:'text',fields:{TEXT:'saved'}}]}},viewState:{scale:1,scrollX:0,scrollY:0}},
  {id:'two',title:'Two',content:{blocks:{blocks:[]}},viewState:{scale:1,scrollX:0,scrollY:0}},
]});

describe('lightweight project title dirty state', () => {
  let state: BlocklyProjectDirtyState, document: BlocklyProjectDocument, head: unknown, blocked: boolean;
  let capture: jasmine.Spy;
  beforeEach(() => {
    document=fixture(); head=undefined; blocked=false;
    capture=jasmine.createSpy('capture').and.callFake(()=>document);
    state=new BlocklyProjectDirtyState(capture,()=>head,()=>blocked,action=>action());
    state.remember(document);
  });
  afterEach(()=>state.reset());

  it('does not capture on ordinary edits, repeated queries or viewport changes', fakeAsync(() => {
    for(let i=1;i<=100;i++) { state.viewport('one',{scale:1,scrollX:i,scrollY:0}); }
    expect(state.changed.value).toBeTrue();
    state.viewport('one',{scale:1,scrollX:0.00000000001,scrollY:0});
    expect(state.changed.value).toBeFalse();
    for(let i=0;i<100;i++) {head={}; state.edited(true);}
    tick(5000); expect(state.changed.value).toBeTrue(); expect(capture).not.toHaveBeenCalled();
  }));

  it('checks undo at the save point once, preserving a changed viewport', fakeAsync(() => {
    head={}; document.pages[0].content.blocks.blocks[0].fields.TEXT='changed'; state.edited(true);
    head=undefined; document.pages[0].content.blocks.blocks[0].fields.TEXT='saved'; state.edited(false);
    document.pages[0].viewState.scrollX=10; state.viewport('one',document.pages[0].viewState);
    tick(200); expect(capture).toHaveBeenCalledTimes(1); expect(state.changed.value).toBeTrue();
    document.pages[0].viewState.scrollX=0; state.viewport('one',document.pages[0].viewState);
    expect(state.changed.value).toBeFalse(); expect(capture).toHaveBeenCalledTimes(1);
  }));

  it('distinguishes redo, a saved checkpoint and a different history branch', fakeAsync(() => {
    const savedHead={}; head=savedHead; document.pages[0].title='new saved title'; state.remember(document);
    head={}; state.edited(true); expect(state.changed.value).toBeTrue();
    head=savedHead; state.edited(false); tick(200); expect(state.changed.value).toBeFalse();
    head={}; document.pages[0].title='branch'; state.edited(true); tick(200);
    expect(state.changed.value).toBeTrue(); expect(capture).toHaveBeenCalledTimes(1);
    // Redo returning to the checkpoint must still verify the document itself.
    head=savedHead; state.edited(false); tick(200); expect(state.changed.value).toBeTrue();
  }));

  it('does not acknowledge inactive-page edits on hydration or library rebuild', fakeAsync(() => {
    const saved=fixture(); document.pages[1].title='unsaved other page';
    state.invalidate(); state.acceptHydration(saved); tick(200);
    expect(state.changed.value).toBeTrue();
    document.pages[1].title='Two'; state.invalidate(); tick(200);
    expect(state.changed.value).toBeFalse();
  }));

  it('reuses existing canonical snapshots and cancels obsolete work after save/reopen', fakeAsync(() => {
    head={}; state.edited(true); state.invalidate();
    state.observeSnapshot(canonicalProjectJsonStringify(document));
    tick(200); expect(state.changed.value).toBeFalse(); expect(capture).not.toHaveBeenCalled();
    state.edited(true); state.invalidate(); state.remember(document); tick(200);
    expect(state.changed.value).toBeFalse(); expect(capture).not.toHaveBeenCalled();
    state.edited(true); state.invalidate(); state.reset(); tick(200);
    expect(state.changed.value).toBeFalse(); expect(capture).not.toHaveBeenCalled();
  }));

  it('waits for transaction/interaction completion and never clears on failed verification', fakeAsync(() => {
    state.edited(true); state.invalidate(); blocked=true; tick(400);
    expect(capture).not.toHaveBeenCalled(); expect(state.changed.value).toBeTrue();
    blocked=false; capture.and.throwError('quarantined'); tick(200);
    expect(state.changed.value).toBeTrue(); tick(1000); expect(capture).toHaveBeenCalledTimes(1);
  }));
});
