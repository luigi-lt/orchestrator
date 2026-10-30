import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "./util.js";

/**
 * Workspace tokens: `<stepId>.<expiresAtSeconds>.<signature>`, HMAC-SHA256 signed.
 * A token is valid for exactly one step until it expires; the gateway also
 * checks that the step is still active, so finishing a step revokes its token.
 */
export function signWorkspaceToken(stepId: string, ttlSeconds: number, secret: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${Buffer.from(stepId).toString("base64url")}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyWorkspaceToken(token: string, secret: string, now = Date.now()): { stepId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedStep, expRaw, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${encodedStep}.${expRaw}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  return { stepId: Buffer.from(encodedStep, "base64url").toString("utf8") };
}

export const tokenHash = (token: string) => sha256(token);
