export interface SharedAuthRecord {
  [key: string]: unknown;
  access_token?: unknown;
  updated_at?: unknown;
}

/** Build the host-owned credential record without changing unrelated fields. */
export function withSharedAccessToken(
  authData: SharedAuthRecord,
  accessToken: string,
  updatedAt: string,
): SharedAuthRecord {
  if (!accessToken.trim()) {
    throw new Error('Shared access token cannot be empty');
  }

  return {
    ...authData,
    access_token: accessToken,
    updated_at: updatedAt,
  };
}
