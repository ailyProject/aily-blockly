import { NoticeService } from '../../src/app/services/core/app-shell/public-api';

/** Integration-side observer; build-domain tests use only their notice port. */
export function recordCompileNotices(logService: any, notices: any[]) {
  const service = new NoticeService(logService);
  const subscription = service.stateSubject.subscribe(notice => notices.push(notice));
  return { update: service.update.bind(service), dispose: () => subscription.unsubscribe() };
}
