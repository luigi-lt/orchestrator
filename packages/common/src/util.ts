import { createHash, randomBytes } from "node:crypto";

/** Time-sortable, URL-safe identifier with a short prefix, e.g. `run_lq3k9x2a7f1c`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable JSON serialization (sorted keys) so hashes don't depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value)).slice(0, 16);
}

export function slugify(text: string, max = 40): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s.slice(0, max).replace(/-+$/g, "") || "change");
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function log(service: string, msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  console.log(`${new Date().toISOString()} [${service}] ${line}`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
