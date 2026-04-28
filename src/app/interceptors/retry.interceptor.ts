import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, from } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { getServerUrl } from '../configs/api.config';

const RETRIABLE_STATUSES = new Set([0, 502, 503, 504]);
const PING_DELAYS_MS = [500, 1000, 2000];

function isRetriable(error: any): boolean {
  if (error instanceof HttpErrorResponse) {
    return RETRIABLE_STATUSES.has(error.status);
  }
  return false;
}

async function pingUntilOk(healthUrl: string): Promise<boolean> {
  for (const delay of PING_DELAYS_MS) {
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      if (res.status < 500) {
        console.info(`[RetryInterceptor] ping succeeded (status ${res.status}), retrying original request...`);
        return true;
      }
      console.info(`[RetryInterceptor] ping returned ${res.status}, retrying ping...`);
    } catch (err) {
      console.info(`[RetryInterceptor] ping failed:`, err);
    }
  }
  console.info('[RetryInterceptor] all ping attempts failed, giving up.');
  return false;
}

export const retryInterceptor: HttpInterceptorFn = (req: HttpRequest<any>, next: HttpHandlerFn): Observable<HttpEvent<any>> => {
  const serverUrl = getServerUrl();
  if (!req.url.startsWith(serverUrl)) {
    return next(req);
  }

  const healthUrl = `${serverUrl}/health`;

  return next(req).pipe(
    catchError((error: any) => {
      if (!isRetriable(error)) {
        return throwError(() => error);
      }
      console.info(`[RetryInterceptor] request failed with status ${error.status}, checking connectivity...`);
      return from(pingUntilOk(healthUrl)).pipe(
        switchMap(ok => ok ? next(req) : throwError(() => error))
      );
    })
  );
};
