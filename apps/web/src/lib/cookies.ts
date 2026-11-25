/** The session: who is signed in. Sent with every request to this app. */
export const SESSION_COOKIE = "hippidy_session";
/** `state` and `nonce` while a person is away at Slack. Sent only to the callback. */
export const SIGN_IN_COOKIE = "hippidy_sign_in";
export const SIGN_IN_COOKIE_PATH = "/auth/slack/callback";

export interface CookieOptions {
  path: string;
  /** Seconds; 0 deletes the cookie. */
  maxAge: number;
}

/**
 * A `Set-Cookie` value. Every cookie of this app is HttpOnly (no script reads it), Secure
 * (https only; browsers also accept it from http://localhost) and SameSite=Lax (sent on the
 * top-level redirect back from Slack, not on cross-site requests from other pages).
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!/^[\w.~-]*$/.test(value)) throw new Error(`cookie ${name}: value is not URL-safe`);
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function deleteCookie(name: string, path: string): string {
  return serializeCookie(name, "", { path, maxAge: 0 });
}

/** One cookie's value from a request's `Cookie` header. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
