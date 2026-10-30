// Fake GitHub for end-to-end tests: the REST endpoints the orchestrator uses, plus local bare git repos.
// Test controls live under /_test. Not for production use.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.env.PORT ?? 8095);
const GIT_ROOT = process.env.FAKE_GIT_ROOT ?? "/fake-git";
const USER = { login: "tester", id: 4242, name: "Test User" };
const REPOS = (process.env.FAKE_REPOS ?? "acme/demo").split(",");

const state = { issues: new Map(), comments: new Map(), events: new Map(), labels: new Map(), pulls: [], nextIssue: 1, nextComment: 1 };

const git = (args, cwd) => execFileSync("git", ["-c", "safe.directory=*", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function initRepo(slug) {
  const bare = join(GIT_ROOT, `${slug}.git`);
  if (existsSync(bare)) return;
  mkdirSync(bare, { recursive: true });
  git(["init", "--bare", "--initial-branch=main", bare]);
  const work = mkdtempSync(join(tmpdir(), "seed-"));
  git(["init", "--initial-branch=main", work]);
  writeFileSync(join(work, "README.md"), "# Demo\n\nA tiny demo project.\n");
  writeFileSync(join(work, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  git(["add", "."], work);
  git(["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "Initial commit"], work);
  git(["push", bare, "main"], work);
  execFileSync("chown", ["-R", "1000:1000", GIT_ROOT]);
}
REPOS.forEach(initRepo);

const send = (res, status, body, headers = {}) => {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
const issueKey = (o, r, n) => `${o}/${r}#${n}`;
const issueJson = (o, r, i) => ({
  number: i.number,
  title: i.title,
  body: i.body,
  html_url: `https://github.example/${o}/${r}/issues/${i.number}`,
  state: i.state,
  labels: [...(state.labels.get(issueKey(o, r, i.number)) ?? [])].map((name) => ({ name })),
  user: { login: USER.login },
  updated_at: i.updatedAt,
});
const touch = (o, r, n) => {
  const i = state.issues.get(issueKey(o, r, n));
  if (i) i.updatedAt = new Date().toISOString();
};

function createIssue(o, r, title, body, label) {
  const number = state.nextIssue++;
  const key = issueKey(o, r, number);
  state.issues.set(key, { number, title, body, state: "open", updatedAt: new Date().toISOString() });
  state.labels.set(key, new Set());
  state.comments.set(key, []);
  state.events.set(key, []);
  if (label) {
    state.labels.get(key).add(label);
    state.events.get(key).push({ event: "labeled", label: { name: label }, actor: { login: USER.login } });
  }
  return number;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  try {
    // --- test controls ---
    if (p[0] === "_test") {
      if (m === "POST" && p[1] === "issues") {
        const b = await readBody(req);
        const [o, r] = (b.repo ?? REPOS[0]).split("/");
        return send(res, 201, { number: createIssue(o, r, b.title, b.body ?? "", b.label) });
      }
      if (m === "POST" && p[1] === "pulls" && p[3] === "merge") {
        const pr = state.pulls.find((x) => x.number === Number(p[2]));
        if (!pr) return send(res, 404, { message: "no pr" });
        pr.state = "closed";
        pr.merged = true;
        return send(res, 200, pr);
      }
      if (m === "GET" && p[1] === "state") {
        return send(res, 200, {
          issues: [...state.issues.entries()].map(([k, v]) => ({ k, ...v, labels: [...state.labels.get(k)] })),
          comments: Object.fromEntries(state.comments),
          pulls: state.pulls,
        });
      }
      if (m === "GET" && p[1] === "branch") {
        const [o, r] = (url.searchParams.get("repo") ?? REPOS[0]).split("/");
        const branch = url.searchParams.get("name");
        const bare = join(GIT_ROOT, `${o}/${r}.git`);
        const log = git(["log", "--format=%H %an <%ae> %s%n%b", `main..${branch}`], bare);
        const files = git(["diff", "--name-only", `main...${branch}`], bare);
        return send(res, 200, { log, files: files.split("\n").filter(Boolean) });
      }
    }
    if (m === "GET" && url.pathname === "/user") return send(res, 200, USER);
    if (p[0] !== "repos") return send(res, 404, { message: `not found: ${m} ${url.pathname}` });
    const [, o, r, kind, n, sub, extra] = p;
    if (!REPOS.includes(`${o}/${r}`)) return send(res, 404, { message: "repo not found" });
    if (m === "GET" && !kind) return send(res, 200, { default_branch: "main", full_name: `${o}/${r}` });

    if (kind === "labels" && m === "POST") return send(res, 201, {});
    if (kind === "issues" && !n && m === "GET") {
      const label = url.searchParams.get("labels");
      const list = [...state.issues.entries()]
        .filter(([k, i]) => k.startsWith(`${o}/${r}#`) && i.state === "open" && (!label || state.labels.get(k).has(label)))
        .map(([, i]) => issueJson(o, r, i));
      const etag = `"${createHash("sha1").update(JSON.stringify(list)).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) return send(res, 304, undefined, { etag });
      return send(res, 200, list, { etag });
    }
    if (kind === "issues" && !n && m === "POST") {
      const b = await readBody(req);
      const number = createIssue(o, r, b.title, b.body ?? "");
      return send(res, 201, issueJson(o, r, state.issues.get(issueKey(o, r, number))));
    }
    const key = issueKey(o, r, n);
    if (kind === "issues" && n && !sub && m === "GET") {
      const i = state.issues.get(key);
      return i ? send(res, 200, issueJson(o, r, i)) : send(res, 404, { message: "no issue" });
    }
    if (kind === "issues" && sub === "events" && m === "GET") return send(res, 200, state.events.get(key) ?? []);
    if (kind === "issues" && sub === "comments") {
      if (m === "GET") {
        const since = url.searchParams.get("since");
        const list = (state.comments.get(key) ?? []).filter((c) => !since || c.created_at >= since);
        return send(res, 200, list);
      }
      const b = await readBody(req);
      const c = { id: state.nextComment++, user: { login: b.author ?? USER.login }, body: b.body, created_at: new Date().toISOString() };
      state.comments.get(key).push(c);
      touch(o, r, n);
      return send(res, 201, c);
    }
    if (kind === "issues" && sub === "labels") {
      const set = state.labels.get(key);
      if (m === "POST") {
        const b = await readBody(req);
        b.labels.forEach((l) => set.add(l));
      } else if (m === "DELETE") {
        if (!set.has(decodeURIComponent(extra))) return send(res, 404, { message: "label not on issue" });
        set.delete(decodeURIComponent(extra));
      }
      touch(o, r, n);
      return send(res, 200, [...set].map((name) => ({ name })));
    }
    if (kind === "pulls" && !n && m === "GET") {
      const head = url.searchParams.get("head")?.split(":")[1];
      return send(res, 200, state.pulls.filter((x) => !head || x.head === head).map((x) => ({ ...x, merged_at: x.merged ? new Date().toISOString() : null })));
    }
    if (kind === "pulls" && !n && m === "POST") {
      const b = await readBody(req);
      const bare = join(GIT_ROOT, `${o}/${r}.git`);
      git(["rev-parse", "--verify", `refs/heads/${b.head}`], bare); // fails if the branch was not pushed
      const pr = { number: state.pulls.length + 1, html_url: `https://github.example/${o}/${r}/pull/${state.pulls.length + 1}`, title: b.title, body: b.body, head: b.head, base: b.base, state: "open", merged: false };
      state.pulls.push(pr);
      return send(res, 201, pr);
    }
    if (kind === "pulls" && n && m === "GET") {
      const pr = state.pulls.find((x) => x.number === Number(n));
      return pr ? send(res, 200, pr) : send(res, 404, { message: "no pr" });
    }
    return send(res, 404, { message: `not implemented: ${m} ${url.pathname}` });
  } catch (err) {
    console.error(err);
    return send(res, 500, { message: String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`fake-github on :${PORT} serving ${REPOS.join(", ")}`));
