export interface AuthSessionInvalidationDependencies {
  closeProtectedTools: () => Promise<void>;
  forceCloseProtectedTools: () => Promise<void>;
  stopProtectedRuntime: () => Promise<void>;
  clearLocalAuthSession: () => Promise<void>;
  completeInvalidation: () => void;
  showSessionReplacedNotice: () => void;
  requestLogin: () => void;
  reportFailure?: (stage: AuthSessionInvalidationFailureStage, error: unknown) => void;
}

export type AuthSessionInvalidationFailureStage =
  | 'graceful-close'
  | 'force-close'
  | 'stop-runtime'
  | 'clear-local-auth';

export interface AuthSessionInvalidationResult {
  gracefulCloseSucceeded: boolean;
  failures: readonly AuthSessionInvalidationFailureStage[];
}

/**
 * Complete a server-authoritative session invalidation without calling the
 * normal logout endpoint. Saving/closing gets the first opportunity, but a
 * failed child lifecycle must never retain an invalid credential locally.
 */
export async function runAuthSessionInvalidation(
  dependencies: AuthSessionInvalidationDependencies,
): Promise<AuthSessionInvalidationResult> {
  const failures: AuthSessionInvalidationFailureStage[] = [];
  const runStage = async (
    stage: AuthSessionInvalidationFailureStage,
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error) {
      failures.push(stage);
      dependencies.reportFailure?.(stage, error);
      return false;
    }
  };

  const gracefulCloseSucceeded = await runStage(
    'graceful-close',
    dependencies.closeProtectedTools,
  );
  if (!gracefulCloseSucceeded) {
    await runStage('force-close', dependencies.forceCloseProtectedTools);
  }

  await runStage('stop-runtime', dependencies.stopProtectedRuntime);
  await runStage('clear-local-auth', dependencies.clearLocalAuthSession);

  // Login state and the user-facing recovery path must settle even if a
  // broken child process or local storage operation failed above.
  dependencies.completeInvalidation();
  dependencies.showSessionReplacedNotice();
  dependencies.requestLogin();

  return {
    gracefulCloseSucceeded,
    failures,
  };
}
