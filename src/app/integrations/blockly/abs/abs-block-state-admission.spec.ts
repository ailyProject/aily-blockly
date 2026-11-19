import { AbsBlockStateAdmission } from './abs-block-state-admission';

describe('first-baseline block state admission', () => {
  it('accepts only the exact inspected facts once', () => {
    const admission = new AbsBlockStateAdmission(), token = admission.issue('canvas/disk', () => true);
    expect(() => admission.consume(token, 'canvas/disk')).not.toThrow();
    expect(() => admission.consume(token, 'canvas/disk')).toThrow();
  });
  for (const reason of ['token', 'facts', 'context', 'expired', 'superseded']) it('rejects stale authority: ' + reason, () => {
    const now = spyOn(Date, 'now').and.returnValue(1000);
    let current = true;
    const admission = new AbsBlockStateAdmission(), token = admission.issue('canvas/disk', () => current);
    if (reason === 'context') current = false;
    if (reason === 'expired') now.and.returnValue(301001);
    if (reason === 'superseded') admission.issue('canvas/disk', () => true);
    expect(() => admission.consume(reason === 'token' ? 'unknown' : token,
      reason === 'facts' ? 'changed' : 'canvas/disk')).toThrow();
  });
});
