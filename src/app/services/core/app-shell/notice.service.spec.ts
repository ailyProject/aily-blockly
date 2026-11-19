import { LogService } from '@core/platform/public-api';
import { NoticeService } from './notice.service';
import type { NoticeOptions } from '@shared/public-api';

describe('通知日志关联', () => {
  let logs: LogService;
  let notices: NoticeService;

  beforeEach(() => {
    logs = new LogService();
    notices = new NoticeService(logs);
  });

  it('在发布通知前关联实际日志，后续输出不改变目标', () => {
    const notice: NoticeOptions = { title: '编译失败', detail: 'missing_symbol', state: 'error' };
    let published: NoticeOptions | undefined;
    notices.stateSubject.subscribe(value => published = { ...value });
    notices.update(notice);
    const target = published!.logTarget;
    expect(target?.mergeKey).toMatch(/^notice-/);
    expect(logs.list.at(-1)).toEqual(target);
    logs.update({ detail: 'unrelated output' });
    expect(published!.logTarget).toBe(target);
    expect(target?.detail).toBe('missing_symbol');
  });

  it('关联已有流式日志且不重复写入，转发时保留原目标', () => {
    logs.update({ title: '编译', detail: 'first failure', state: 'error' });
    logs.update({ detail: 'unrelated output' });
    const notice: NoticeOptions = { title: '编译失败', detail: 'first failure\nfull diagnostics', state: 'error', sendToLog: false };
    notices.update(notice);
    expect(notice.logTarget).toEqual(logs.list[0]);
    logs.update({ detail: 'later output' });
    notices.update({ ...notice, sendToLog: false });
    expect(notices.data.logTarget?.detail).toBe('first failure');
    expect(logs.list.length).toBe(3);
  });

  it('同毫秒相同错误的不同通知具有不同日志目标', () => {
    spyOn(Date, 'now').and.returnValue(1234);
    notices.update({ title: 'Error', detail: 'same error', state: 'error' });
    const first = notices.data.logTarget;
    notices.update({ title: 'Error', detail: 'same error', state: 'error' });
    expect(first?.timestamp).toBe(notices.data.logTarget?.timestamp);
    expect(first?.mergeKey).not.toBe(notices.data.logTarget?.mergeKey);
  });
});
