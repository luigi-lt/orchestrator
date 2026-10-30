import type { ServerResponse } from "node:http";
import type { StreamNotice } from "@orch/contracts";

/** Fans stream notices out to connected browsers over server-sent events. */
export class StreamHub {
  private clients = new Set<ServerResponse>();
  private nextId = 1;

  constructor() {
    setInterval(() => this.writeAll(": keep-alive\n\n"), 25_000).unref();
  }

  add(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(notice: StreamNotice): void {
    this.writeAll(`id: ${this.nextId++}\ndata: ${JSON.stringify(notice)}\n\n`);
  }

  private writeAll(chunk: string): void {
    for (const c of this.clients) {
      try {
        c.write(chunk);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
