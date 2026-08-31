import type { AuthService } from '../auth.service';
import { getServerUrl } from '../../../../configs/api.config';

export const AILY_HOST_AUTH_REQUEST_CHANNEL = 'child-tool-host-auth-request';
export const AILY_HOST_AUTH_RESPONSE_CHANNEL = 'child-tool-host-auth-response';

export type AilyHostAuthOperation = 'access-token' | 'refresh-access-token' | 'logout';

export interface AilyHostAuthRuntimeRequest {
  relayId?: unknown;
  operation?: unknown;
  rejectedGeneration?: unknown;
}

export interface AilyHostAuthRuntimeResult {
  ok: boolean;
  authenticated?: boolean;
  accessToken?: string;
  apiServer?: string;
  generation: number;
  errorCode?: string;
  message?: string;
}

export interface AilyHostAuthRuntimeAuthService {
  readonly isLoggedIn: boolean;
  readonly isSessionInvalidating: boolean;
  initializeAuth(): Promise<void>;
  getToken2(): Promise<string | null>;
  getAuthCredentialGeneration(): number;
  refreshAuthToken(): Promise<boolean>;
  logout(): Promise<void>;
}

interface IpcRendererLike {
  on?(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener?(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  send?(channel: string, payload: unknown): void;
}

export function createAilyHostAuthRequestHandler(
  authService: AilyHostAuthRuntimeAuthService,
  resolveApiServer: () => string = getServerUrl,
): (request: AilyHostAuthRuntimeRequest) => Promise<AilyHostAuthRuntimeResult> {
  let refreshPromise: Promise<boolean> | null = null;

  const readLease = async (): Promise<AilyHostAuthRuntimeResult> => {
    if (!authService.isLoggedIn || authService.isSessionInvalidating) {
      return failure(authService, 'AUTH_SIGNED_OUT', 'The host account is signed out');
    }

    const accessToken = (await authService.getToken2())?.trim();
    if (!accessToken) {
      return failure(authService, 'AUTH_CREDENTIAL_UNAVAILABLE', 'The host access token is unavailable');
    }
    const apiServer = normalizeApiServer(resolveApiServer());
    if (!apiServer) {
      return failure(authService, 'HOST_API_SERVER_UNAVAILABLE', 'The host API server is unavailable');
    }

    return {
      ok: true,
      authenticated: true,
      accessToken,
      apiServer,
      generation: authService.getAuthCredentialGeneration(),
    };
  };

  return async (request): Promise<AilyHostAuthRuntimeResult> => {
    const operation = normalizeOperation(request.operation);
    if (!operation) {
      return failure(authService, 'HOST_AUTH_INVALID_REQUEST', 'Unsupported host authentication operation');
    }

    if (operation === 'logout') {
      await authService.logout();
      return {
        ok: true,
        authenticated: false,
        generation: authService.getAuthCredentialGeneration(),
      };
    }

    // The main window normally owns an already-initialized AuthService. Only
    // recover startup state when the bridge is called before that initialization
    // has completed; otherwise every Aily API request would repeat `/me`.
    if (!authService.isLoggedIn && !authService.isSessionInvalidating) {
      await authService.initializeAuth();
    }
    if (operation === 'access-token') {
      return readLease();
    }

    const rejectedGeneration = normalizeGeneration(request.rejectedGeneration);
    if (
      rejectedGeneration !== undefined
      && rejectedGeneration !== authService.getAuthCredentialGeneration()
    ) {
      return readLease();
    }

    if (!authService.isLoggedIn || authService.isSessionInvalidating) {
      return failure(authService, 'AUTH_SIGNED_OUT', 'The host account is signed out');
    }

    if (!refreshPromise) {
      const operationPromise = authService.refreshAuthToken();
      refreshPromise = operationPromise;
      const clearOperation = () => {
        if (refreshPromise === operationPromise) refreshPromise = null;
      };
      void operationPromise.then(clearOperation, clearOperation);
    }

    const refreshed = await refreshPromise;
    if (!refreshed) {
      return failure(authService, 'AUTH_REFRESH_FAILED', 'The host could not refresh the access token');
    }
    return readLease();
  };
}

export function registerAilyChatHostAuthRuntimeBridge(
  authService: AuthService,
  ipcRenderer: IpcRendererLike | undefined,
): () => void {
  if (!ipcRenderer?.on || !ipcRenderer.send) return () => undefined;

  const handleRequest = createAilyHostAuthRequestHandler(authService);
  const listener = (_event: unknown, payload: unknown): void => {
    const request = asRecord(payload);
    const relayId = typeof request?.['relayId'] === 'string' ? request['relayId'].trim() : '';
    if (!relayId) return;

    void handleRequest(request as AilyHostAuthRuntimeRequest)
      .then(result => ipcRenderer.send?.(AILY_HOST_AUTH_RESPONSE_CHANNEL, { relayId, result }))
      .catch(() => {
        ipcRenderer.send?.(AILY_HOST_AUTH_RESPONSE_CHANNEL, {
          relayId,
          result: failure(authService, 'HOST_AUTH_FAILED', 'The host authentication operation failed'),
        });
      });
  };

  const cleanup = ipcRenderer.on(AILY_HOST_AUTH_REQUEST_CHANNEL, listener);
  return typeof cleanup === 'function'
    ? cleanup as () => void
    : () => ipcRenderer.removeListener?.(AILY_HOST_AUTH_REQUEST_CHANNEL, listener);
}

function failure(
  authService: AilyHostAuthRuntimeAuthService,
  errorCode: string,
  message: string,
): AilyHostAuthRuntimeResult {
  return {
    ok: false,
    authenticated: false,
    generation: authService.getAuthCredentialGeneration(),
    errorCode,
    message,
  };
}

function normalizeOperation(value: unknown): AilyHostAuthOperation | undefined {
  return value === 'access-token' || value === 'refresh-access-token' || value === 'logout'
    ? value
    : undefined;
}

function normalizeGeneration(value: unknown): number | undefined {
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 0 ? generation : undefined;
}

function normalizeApiServer(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.pathname = url.pathname.replace(/\/+$/u, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/u, '');
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
