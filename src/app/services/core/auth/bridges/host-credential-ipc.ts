const credentialPhases = {
  AUTH_CREDENTIALS_LOCK_TIMEOUT: 'credential-lock',
  AUTH_CREDENTIALS_LOCK_UNVERIFIED: 'credential-lock',
  AUTH_CREDENTIALS_LOCK_SHUTDOWN: 'credential-lock',
  AUTH_CREDENTIALS_LOCK_UNAVAILABLE: 'credential-lock',
  AUTH_CREDENTIALS_STORAGE_DENIED: 'credential-storage',
  AUTH_CREDENTIALS_STORAGE_IO: 'credential-storage',
  AUTH_CREDENTIALS_IPC_UNAVAILABLE: 'credential-ipc',
} as const;

type HostCredentialCode = keyof typeof credentialPhases;

export class HostCredentialOperationError extends Error {
  readonly phase: (typeof credentialPhases)[HostCredentialCode];

  constructor(readonly code: HostCredentialCode) {
    super(code);
    this.phase = credentialPhases[code];
  }
}

export async function invokeHostCredential<T>(operation: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await operation(); }
  catch { throw new HostCredentialOperationError('AUTH_CREDENTIALS_IPC_UNAVAILABLE'); }
  const envelope = (result as { credentialError?: { version?: unknown; code?: unknown } } | null)?.credentialError;
  if (envelope) {
    const code = envelope.code;
    if (envelope.version === 1 && typeof code === 'string' && Object.hasOwn(credentialPhases, code)) {
      throw new HostCredentialOperationError(code as HostCredentialCode);
    }
    throw new HostCredentialOperationError('AUTH_CREDENTIALS_IPC_UNAVAILABLE');
  }
  return result;
}
