/**
 * Browser-side calls to our own JSON API. Same origin, so the session cookie
 * and the Origin header (the API's CSRF check) are sent automatically, and
 * every rate limit and permission check in the API applies.
 */
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export async function callApi<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const init: RequestInit = { method, credentials: "same-origin" };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await fetch(path, init);
    const json = (await res.json().catch(() => ({}))) as { message?: string } & T;
    if (!res.ok) {
      const error =
        res.status === 429
          ? "Too many requests. Wait a minute and try again."
          : res.status === 401
            ? "Your login has expired. Log in again."
            : (json.message ?? `Something went wrong (${res.status}).`);
      return { ok: false, status: res.status, error };
    }
    return { ok: true, status: res.status, data: json };
  } catch {
    return { ok: false, status: 0, error: "Couldn't reach NightShift. Check your connection and try again." };
  }
}
