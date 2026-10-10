import {fakeAsync, tick} from '@angular/core/testing';
import {CodeViewerIpcService} from './code-viewer-ipc.service';

describe('code viewer publication during Blockly interaction', () => {
  let service: CodeViewerIpcService, publish: jasmine.Spy, previous: unknown;
  beforeEach(() => {
    previous = (window as any).codeViewer;
    publish = jasmine.createSpy('publish'); (window as any).codeViewer = {publishState: publish};
    service = new CodeViewerIpcService();
  });
  afterEach(() => { service.clear(); (window as any).codeViewer = previous; });
  it('keeps selection live and publishes only the newest complete map after editing ends', fakeAsync(() => {
    let busy = true;
    service.publishCodeState('old', new Map(), 'a', [], () => busy);
    tick(200); expect(publish).not.toHaveBeenCalled();
    service.publishSelection('b', ['b', 'c']);
    expect(publish.calls.mostRecent().args[0]).toEqual({selectedBlockId: 'b', selectedBlockIds: ['b', 'c']});
    publish.calls.reset();
    const map = new Map([['b', {blockId: 'b'} as any]]);
    service.publishCodeState('new', map, 'b', ['c'], () => busy);
    tick(600); expect(publish).not.toHaveBeenCalled();
    busy = false; tick(200);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({code: 'new', blockCodeMap: [...map], selectedBlockIds: ['b', 'c']}));
  }));
  it('cancels pending interaction retries when the project/code view clears', fakeAsync(() => {
    service.publishCodeState('old', new Map(), null, [], () => true);
    tick(200); service.clear(); publish.calls.reset(); tick(1000);
    expect(publish).not.toHaveBeenCalled();
  }));
});
