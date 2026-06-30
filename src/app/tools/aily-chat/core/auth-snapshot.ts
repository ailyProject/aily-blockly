export interface AuthQuotaSummary {
  readonly totalToken: number;
  readonly usedToken: number;
  readonly remainingToken: number;
  readonly resetTime?: string;
}

export interface AuthQuotaInfoSnapshotItem {
  readonly entitlement: number;
  readonly remaining: number;
  readonly percentRemaining: number;
  readonly unlimited?: boolean;
  readonly overageCount?: number;
  readonly overagePermitted?: boolean;
  readonly resetDate?: string;
}

export interface AuthQuotaInfoSnapshot {
  readonly source: 'auth-me' | 'token';
  readonly quotaResetDate?: string;
  readonly quotaSnapshots?: Readonly<Record<string, AuthQuotaInfoSnapshotItem>>;
  readonly limitedUserQuotas?: Readonly<Record<string, number>>;
}

export interface AuthInvitationInfo {
  readonly is_invited?: boolean;
  readonly compile_validated?: boolean;
  readonly [key: string]: unknown;
}

export interface AuthUserInfo {
  readonly id?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly nickname?: string;
  readonly login?: string;
  readonly avatar?: string;
  readonly groups?: readonly string[];
  readonly invitation?: AuthInvitationInfo;
  readonly subscription_plan?: {
    readonly name?: string;
    readonly service_tier?: string;
    readonly status?: string;
    readonly end_date?: string;
  };
  readonly quota?: {
    readonly total_token?: number;
    readonly used_token?: number;
    readonly remaining_token?: number;
    readonly reset_time?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly entitlements?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface AuthSnapshot {
  readonly plan?: string;
  readonly serviceTier?: string;
  readonly subscriptionStatus?: string;
  readonly subscriptionEndDate?: string;
  readonly groups?: readonly string[];
  readonly quotaSummary?: AuthQuotaSummary;
  readonly quotaInfoSnapshot?: AuthQuotaInfoSnapshot;
  readonly entitlements?: Readonly<Record<string, unknown>>;
}