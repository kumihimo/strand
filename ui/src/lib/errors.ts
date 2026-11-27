export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const SESSION_EXPIRED = 'Session expired — reopen the link printed by strand cockpit';

/** Map a failed HTTP response (or network failure, status 0) to an ApiError. */
export function errorFromResponse(status: number, bodyText: string): ApiError {
  if (status === 401) return new ApiError(401, SESSION_EXPIRED);
  if (status === 0) return new ApiError(0, `Cannot reach the cockpit server: ${bodyText}`);
  let err: unknown;
  try {
    err = (JSON.parse(bodyText) as { error?: unknown } | null)?.error;
  } catch {
    err = undefined;
  }
  return new ApiError(status, typeof err === 'string' && err ? err : `request failed (${status})`);
}
