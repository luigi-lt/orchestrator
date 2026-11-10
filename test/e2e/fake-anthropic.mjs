// Fake Anthropic Messages API for end-to-end tests. It plays the analyst, the planner, the implementer and the
// front-door assistant deterministically, based on the tools offered in each request.
// Markers in the issue text choose the analyst's behavior: [ask] asks a question first, [web] opens the
// second repository and finds two products, [guided] proposes the guided track after one rejected submission.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8099);
let counter = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}`;

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });

const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");

const assistantToolUses = (messages) =>
  messages.filter((m) => m.role === "assistant").flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : []));

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const t = textOf(m.content);
    if (t.trim()) return t;
  }
  return "";
}

function lastIsToolResult(messages) {
  const last = messages[messages.length - 1];
  return last && last.role === "user" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
}

function findWriteTool(tools) {
  const pathKeys = ["path", "file_path", "filePath", "filename"];
  const contentKeys = ["file_text", "content", "contents", "text", "new_str"];
  for (const t of tools) {
    const props = Object.keys(t.input_schema?.properties ?? {});
    const pk = pathKeys.find((k) => props.includes(k));
    const ck = contentKeys.find((k) => props.includes(k));
    if (pk && ck && /create|write/i.test(t.name)) return { tool: t, pk, ck };
  }
  return null;
}

function findShellTool(tools) {
  return tools.find((t) => /^(bash|shell|powershell|run_in_terminal|terminal)$/i.test(t.name) || (/bash|shell/i.test(t.name) && t.input_schema?.properties?.command));
}

// What the tests can ask about afterwards (GET /_test/state).
const seen = { requests: 0, guidanceInPrompt: false, guidanceInSystem: false };
const GUIDANCE_MARKER = "E2E-GUIDANCE-MARKER";

const analysisBase = {
  ready: true,
  questions: [],
  understanding: "Add a subtract function next to add in the calculator library.",
  products: [{ product: "calc", repositories: ["acme/demo"], reason: "It owns the arithmetic functions.", changes: "A new subtract function." }],
  likelyFiles: ["acme/demo:subtract.js"],
  risks: [],
  assumptions: ["Numbers only"],
  acceptanceCriteria: ["subtract(5, 3) returns 2"],
  size: "S",
  clearBehavior: true,
  singleArea: true,
  changesContracts: false,
  proposedTrack: "fast",
  trackReasons: ["One small function in one file"],
  approach: "Create subtract.js exporting subtract(a, b).",
};

/** The analyst: places the work in products and proposes a track. */
function analyse(prompt, used) {
  const submit = (input) => [{ type: "tool_use", id: id("toolu"), name: "submit_analysis", input }];
  const submits = used.filter((u) => u.name === "submit_analysis").length;
  if (/\[ask\]/.test(prompt) && !/Earlier questions/.test(prompt)) {
    if (submits) return [{ type: "text", text: "Questions submitted." }];
    return submit({ ...analysisBase, ready: false, questions: ["Should subtract also handle strings?"], products: [] });
  }
  if (/\[web\]/.test(prompt)) {
    if (!used.some((u) => u.name === "request_repository")) {
      return [{ type: "tool_use", id: id("toolu"), name: "request_repository", input: { repository: "acme/web", reason: "The ticket mentions the shop page." } }];
    }
    if (submits) return [{ type: "text", text: "Analysis submitted." }];
    return submit({
      ...analysisBase,
      understanding: "Add subtract to the calculator and show it on the shop page.",
      products: [...analysisBase.products, { product: "shop", repositories: ["acme/web"], reason: "The page must call the new function.", changes: "Use subtract on the page." }],
      likelyFiles: ["acme/demo:subtract.js", "acme/web:page.js"],
    });
  }
  if (/\[guided\]/.test(prompt)) {
    // The first submission names a product that is not in the catalog; the gateway must send it back.
    if (submits === 0) return submit({ ...analysisBase, products: [{ ...analysisBase.products[0], product: "calculator" }] });
    if (submits === 1) return submit({ ...analysisBase, size: "M", singleArea: false, proposedTrack: "guided", trackReasons: ["Needs a design choice"] });
    return [{ type: "text", text: "Analysis submitted." }];
  }
  if (submits) return [{ type: "text", text: "Analysis submitted." }];
  return submit(analysisBase);
}

/** Decides the next assistant content blocks for a request. */
function decide(body) {
  const tools = body.tools ?? [];
  const names = tools.map((t) => t.name);
  const messages = body.messages ?? [];
  const used = assistantToolUses(messages);
  const prompt = lastUserText(messages);

  seen.requests++;
  if (JSON.stringify(messages).includes(GUIDANCE_MARKER)) seen.guidanceInPrompt = true;
  if (JSON.stringify(body.system ?? "").includes(GUIDANCE_MARKER)) seen.guidanceInSystem = true;

  if (names.includes("submit_analysis")) return analyse(prompt, used);

  // Planner
  if (names.includes("submit_assessment")) {
    if (used.some((u) => u.name === "submit_assessment")) return [{ type: "text", text: "Assessment submitted." }];
    const input = {
          ready: true,
          questions: [],
          plan: {
            summary: "Add a subtract function next to add.",
            subtasks: [
              {
                title: "Add subtract function",
                description: "Create subtract.js exporting subtract(a, b).",
                acceptanceCriteria: ["subtract(5, 3) returns 2"],
              },
            ],
          },
    };
    return [{ type: "tool_use", id: id("toolu"), name: "submit_assessment", input }];
  }

  // Implementer
  if (names.includes("submit_result")) {
    if (used.some((u) => u.name === "submit_result")) return [{ type: "text", text: "Done." }];
    if (used.length > 0) return [{ type: "tool_use", id: id("toolu"), name: "submit_result", input: { summary: "Added subtract.js with subtract(a, b)." } }];
    const content = "export function subtract(a, b) {\n  return a - b;\n}\n";
    // The prompt lists the checkouts; the writable one is where the change goes.
    const dir = /^- (\/workspace\/repos\/\S+) — .*writable\)$/m.exec(prompt)?.[1];
    if (!dir) return [{ type: "text", text: "No writable repository in the prompt." }];
    const target = `${dir}/subtract.js`;
    const write = findWriteTool(tools);
    if (write) {
      return [{ type: "tool_use", id: id("toolu"), name: write.tool.name, input: { [write.pk]: target, [write.ck]: content } }];
    }
    const shell = findShellTool(tools);
    if (shell) {
      const extra = shell.input_schema?.properties?.description ? { description: "Create subtract.js" } : {};
      return [{ type: "tool_use", id: id("toolu"), name: shell.name, input: { command: `printf '%s' '${content.replace(/\n/g, "\\n")}' | sed 's/\\\\n/\\n/g' > ${target} && cat ${target}`, ...extra } }];
    }
    return [{ type: "text", text: `No usable tool among: ${names.join(", ")}` }];
  }

  // Front-door assistant
  if (names.includes("submit_work_item")) {
    if (lastIsToolResult(messages)) {
      const lastTool = used[used.length - 1]?.name;
      return [{ type: "text", text: lastTool === "render" ? "Here is the table you asked for." : "Done — the orchestrator is on it." }];
    }
    const issue = /(?:issue\s*#?|#)(\d+)/i.exec(prompt);
    if (issue) return [{ type: "tool_use", id: id("toolu"), name: "submit_work_item", input: { repo: "acme/demo", issueNumber: Number(issue[1]) } }];
    if (/table/i.test(prompt)) {
      return [
        {
          type: "tool_use",
          id: id("toolu"),
          name: "render",
          input: { components: [{ type: "table", title: "Example", columns: ["Name", "Value"], rows: [["answer", "42"]] }] },
        },
      ];
    }
    return [{ type: "text", text: "Hello! I am the fake model. Ask me to work on an issue, e.g. 'work on issue #1'." }];
  }

  return [{ type: "text", text: "OK." }];
}

function writeStream(res, body, blocks) {
  const msgId = id("msg");
  const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  ev("message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
  });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev("content_block_stop", { type: "content_block_stop", index });
  });
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/_test/state") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(seen));
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5", type: "model", display_name: "Fake Opus" }], has_more: false }));
  }
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ input_tokens: 100 }));
  }
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const body = await readBody(req);
    const blocks = decide(body);
    console.log(
      JSON.stringify({
        key: req.headers["x-api-key"] === "fake-key" ? "injected" : `unexpected:${req.headers["x-api-key"]}`,
        stream: !!body.stream,
        tools: (body.tools ?? []).map((t) => t.name),
        reply: blocks.map((b) => (b.type === "text" ? `text:${b.text.slice(0, 40)}` : `tool:${b.name}`)),
      }),
    );
    if (body.stream) return writeStream(res, body, blocks);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        id: id("msg"),
        type: "message",
        role: "assistant",
        model: body.model,
        content: blocks,
        stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
  }
  console.log(`unhandled ${req.method} ${url.pathname}`);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`fake-anthropic on :${PORT}`));
