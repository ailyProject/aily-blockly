/** The first reply is bounded by the caller; an acknowledged user dialog is not. */
export async function resolveChildCloseDecision(remote: any, result: any): Promise<boolean> {
  if (result?.confirmationPending === true) {
    if (typeof remote?.waitForCloseDecision !== 'function') return false;
    return await remote.waitForCloseDecision() === true;
  }
  return result !== false && result?.canClose !== false;
}
