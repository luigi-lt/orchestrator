/**
 * egress-proxy: the sandboxes' only way out.
 *  - :8080  /anthropic/* → Anthropic API, adding the API key (the key never enters a sandbox).
 *  - :3128  HTTP forward proxy (CONNECT and plain HTTP) restricted to an allowlist of package registries.
 */
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { EnvHttpProxyAgent, request as undiciRequest } from "undici";
import { config, isHostAllowed, log } from "@orch/common";

const apiKey = config.anthropicApiKey();
const upstream = config.anthropicUpstream().replace(/\/$/, "");
const allowlist = config.egressAllowlist();
const dispatcher = new EnvHttpProxyAgent();

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length"]);
const STRIP_INBOUND = new Set(["authorization", "x-api-key", "cookie"]);

const modelApi = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/healthz") return void res.writeHead(200).end("ok");
  if (!url.startsWith("/anthropic/")) return void res.writeHead(404).end("not found");
  const target = `${upstream}${url.slice("/anthropic".length)}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || STRIP_INBOUND.has(key) || v === undefined) continue;
    headers[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["x-api-key"] = apiKey;
  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstreamRes = await undiciRequest(target, {
      method: (req.method ?? "GET") as "GET",
      headers,
      body: hasBody ? (req as unknown as Readable) : undefined,
      dispatcher,
      bodyTimeout: 15 * 60 * 1000,
      headersTimeout: 5 * 60 * 1000,
    });
    const outHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) outHeaders[k] = v;
    }
    res.writeHead(upstreamRes.statusCode, outHeaders);
    for await (const chunk of upstreamRes.body) res.write(chunk);
    res.end();
  } catch (err) {
    log("egress-proxy", `model API request failed: ${(err as Error).message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "egress proxy could not reach the model API" } }));
  }
});

const forwardProxy = http.createServer((req, res) => {
  // Plain HTTP request in absolute form: GET http://host/path
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    return void res.writeHead(400).end("absolute URL required");
  }
  if (!isHostAllowed(target.hostname, allowlist)) {
    log("egress-proxy", `blocked http ${target.hostname}`);
    return void res.writeHead(403).end(`egress to ${target.hostname} is not allowed`);
  }
  const upstreamReq = http.request(
    { host: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, method: req.method, headers: req.headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", () => res.writeHead(502).end());
  req.pipe(upstreamReq);
});

forwardProxy.on("connect", (req, clientSocket: net.Socket, head) => {
  const [host, portRaw] = (req.url ?? "").split(":");
  const port = Number.parseInt(portRaw ?? "443", 10);
  if (!host || !isHostAllowed(host, allowlist) || port !== 443) {
    log("egress-proxy", `blocked connect ${req.url}`);
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstreamSocket = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  const close = () => {
    upstreamSocket.destroy();
    clientSocket.destroy();
  };
  upstreamSocket.on("error", close);
  clientSocket.on("error", close);
});

modelApi.listen(8080, "0.0.0.0", () => log("egress-proxy", `model API on :8080 → ${upstream}`));
forwardProxy.listen(3128, "0.0.0.0", () => log("egress-proxy", `forward proxy on :3128, allowlist: ${allowlist.join(", ")}`));
