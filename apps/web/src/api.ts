import type { StreamNotice } from "@orch/contracts";

export class ApiError extends Error {}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json", "x-orch-client": "web" } : { "x-orch-client": "web" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError((data && data.error) || `${res.status} ${res.statusText}`);
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const put = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "PUT", body });

type Listener = (n: StreamNotice) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;

/** One EventSource for the whole app; components subscribe to the notices they care about. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) {
    source = new EventSource("/api/stream");
    source.onmessage = (e) => {
      try {
        const notice = JSON.parse(e.data) as StreamNotice;
        listeners.forEach((l) => l(notice));
      } catch {
        // ignore
      }
    };
  }
  return () => listeners.delete(listener);
}
