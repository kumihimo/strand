export class ApiError extends Error {
  status: number;
  /** Per-field messages from a refused form (the Settings PUT), when the server sent them. */
  fields?: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (fields) this.fields = fields;
  }
}

export const SESSION_EXPIRED = 'Session expired — reopen the link printed by strand cockpit';

/** Map a failed HTTP response (or network failure, status 0) to an ApiError. */
export function errorFromResponse(status: number, bodyText: string): ApiError {
  if (status === 401) return new ApiError(401, SESSION_EXPIRED);
  if (status === 0) return new ApiError(0, `Cannot reach the cockpit server: ${bodyText}`);
  let err: unknown;
  let rawFields: unknown;
  try {
    const body = JSON.parse(bodyText) as { error?: unknown; fields?: unknown } | null;
    err = body?.error;
    rawFields = body?.fields;
  } catch {
    err = undefined;
  }
  let fields: Record<string, string> | undefined;
  if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
    fields = {};
    for (const [k, v] of Object.entries(rawFields)) if (typeof v === 'string') fields[k] = v;
  }
  return new ApiError(status, typeof err === 'string' && err ? err : `request failed (${status})`, fields);
}
