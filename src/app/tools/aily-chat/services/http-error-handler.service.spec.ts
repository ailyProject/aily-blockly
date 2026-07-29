import { getQuotaUsageText } from './http-error-handler.service';

describe('http-error-handler service helpers', () => {
  it('uses daily usage text for daily quota responses', () => {
    const usageText = getQuotaUsageText({
      error: 'quota_exceeded',
      message: '今日AI对话免费次数已用完',
      limit: 30,
      used: 32,
      remaining: 0,
      resetDate: '2026-07-21T00:00:00+08:00',
      quotaPeriod: 'daily'
    });

    expect(usageText).toBe('本日已用 32/30 次。');
  });

  it('keeps monthly usage text for monthly quota responses', () => {
    const usageText = getQuotaUsageText({
      error: 'quota_exceeded',
      message: '本月AI对话免费次数已用完',
      limit: 300,
      used: 302,
      quotaPeriod: 'monthly'
    });

    expect(usageText).toBe('本月已用 302/300 次。');
  });
});