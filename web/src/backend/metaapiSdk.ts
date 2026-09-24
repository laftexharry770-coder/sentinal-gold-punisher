import type { MetaApiClient } from '@sentinal/engine';

/**
 * Opens MetaApi's official SDK with the operator's token.
 *
 * The SDK is only pulled in when someone actually connects, so demo mode and
 * the sign-in screen never pay for it.
 */
export async function createMetaApiClient(token: string): Promise<MetaApiClient> {
  const problem = tokenProblem(token);
  if (problem) throw new Error(problem);
  const { default: MetaApi } = await import('metaapi.cloud-sdk');
  const client: MetaApiClient = new MetaApi(token.trim(), {
    requestTimeout: 60,
    retryOpts: { retries: 3, minDelayInSeconds: 1, maxDelayInSeconds: 30 },
  });
  return client;
}

/**
 * MetaApi tokens are JSON Web Tokens: three dot-separated parts, the middle
 * one JSON. The SDK reads that part itself and fails with a bare parser error
 * on anything else, so a bad paste is caught here and named for what it is.
 */
export function tokenProblem(token: string): string | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return "That isn't a MetaApi token. Copy the whole API access token from app.metaapi.cloud — a long line of text in three parts, starting eyJ.";
  }
  try {
    const json = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1]!.length / 4) * 4, '='));
    const payload = JSON.parse(json) as { accessRules?: unknown };
    // Every MetaApi API token carries its access rules; the SDK reads them first.
    if (!Array.isArray(payload.accessRules)) {
      return "That token has no MetaApi access rules, so it isn't a MetaApi API access token. Generate one at app.metaapi.cloud/token.";
    }
    return null;
  } catch {
    return 'That token is cut short or altered. Copy it again from app.metaapi.cloud, all of it.';
  }
}

/** MetaApi's errors, as something the operator can act on. */
export function explainMetaApiError(err: unknown): string {
  const e = (err ?? {}) as { name?: string; message?: string; status?: number; details?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(err);
  switch (e.name) {
    case 'UnauthorizedError':
      return 'MetaApi refused this token. Copy the API access token again from app.metaapi.cloud (Account → API access token).';
    case 'ForbiddenError':
      return `MetaApi says this token may not do that: ${message}`;
    case 'NotFoundError':
      return `MetaApi could not find it: ${message}`;
    case 'TooManyRequestsError':
      return 'MetaApi is rate-limiting this token. Wait a minute and try again.';
    case 'ValidationError': {
      const details = e.details as { code?: string } | string | undefined;
      const code = typeof details === 'string' ? details : details?.code;
      if (code === 'E_SRV_NOT_FOUND') return `MetaApi does not know that server name. ${message}`;
      if (code === 'E_AUTH') return 'The broker refused that login and password.';
      if (code === 'E_SERVER_TIMEZONE') return 'MetaApi could not read the broker settings. Try again in a few minutes.';
      return message;
    }
    case 'TimeoutError':
      return `MetaApi did not answer in time: ${message}`;
    default:
      if (/is not valid JSON|Unexpected token/i.test(message)) {
        return 'MetaApi could not read that token. Copy it again from app.metaapi.cloud, all of it.';
      }
      if (/Failed to fetch|NetworkError|Network Error|ERR_|ECONN|ENOTFOUND|timeout of/i.test(message)) {
        return `Could not reach MetaApi (${message}). Check the connection, or whether a firewall or ad blocker is blocking agiliumtrade.ai.`;
      }
      return message;
  }
}
