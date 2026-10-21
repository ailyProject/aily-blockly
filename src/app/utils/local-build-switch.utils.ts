import { Observable } from 'rxjs';

export const CLOUD_BUILD_CLOUD_REQUESTED = 'CLOUD_BUILD_CLOUD_REQUESTED';

/** Keep the original build pending until the local process and its stop acknowledgement finish. */
export function withLocalBuildSwitch<T extends { type?: string }>(source: Observable<T>, options: {
  isCurrent: () => boolean;
  stop: () => Promise<boolean>;
  ready: (request: () => boolean) => void;
  switching: (pending: Promise<void>) => void;
}): Observable<T> {
  return new Observable(observer => {
    let ended = false, switching = false, registered = false;
    let exited!: () => void;
    const completion = new Promise<void>(resolve => { exited = resolve; });
    const request = () => {
      if (ended || switching || !options.isCurrent()) return false;
      switching = true;
      const pending = (async () => {
        let stopped = false, failure: unknown;
        try { stopped = await options.stop(); } catch (error) { failure = error; }
        // A failed kill must not release the task while a compiler still owns the workspace.
        if (!stopped) await completion;
        if (ended) return;
        if (failure) throw failure;
        if (!stopped) throw new Error('Local compiler did not confirm cancellation.');
      })();
      options.switching(pending);
      void pending.then(() => {
        if (!ended) observer.error(Object.assign(new Error('Continue this build in the cloud.'), {
          code: options.isCurrent() ? CLOUD_BUILD_CLOUD_REQUESTED : 'CANCELLED',
        }));
      }, error => { if (!ended) observer.error(error); });
      return true;
    };
    const subscription = source.subscribe({
      next: event => {
        if (event.type === 'close' || event.type === 'error') exited();
        if (switching || ended) return;
        // The first real output confirms that the process was registered in main.
        if (!registered && event.type !== 'close' && event.type !== 'error') {
          registered = true;
          options.ready(request);
        }
        observer.next(event);
      },
      error: error => { exited(); if (!switching) observer.error(error); },
      complete: () => { exited(); if (!switching) observer.complete(); },
    });
    return () => { ended = true; exited(); subscription.unsubscribe(); };
  });
}
