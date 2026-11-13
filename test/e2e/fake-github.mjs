// Fake GitHub for end-to-end tests: the REST endpoints the orchestrator uses, plus local bare git repos.
// Test controls live under /_test. Not for production use.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.env.PORT ?? 8095);
const GIT_ROOT = process.env.FAKE_GIT_ROOT ?? "/fake-git";
const USER = { login: "tester", id: 4242, name: "Test User" };
const REPOS = (process.env.FAKE_REPOS ?? "acme/demo,acme/web").split(",");

// Seed content per repository. acme/demo carries guidance from its product team (FR-M6).
const SEED = {
  "acme/demo": {
    "README.md": "# Demo\n\nA tiny calculator library.\n",
    "math.js": "export function add(a, b) {\n  return a + b;\n}\n",
    // The product's test command (products.yaml): passes once subtract works.
    "test.mjs": "import('./subtract.js').then((m) => process.exit(m.subtract(5, 3) === 2 ? 0 : 1), () => process.exit(1));\n",
    "AGENTS.md": "# Guidance for agents\n\nE2E-GUIDANCE-MARKER: one exported function per file, two-space indentation.\n",
  },
  "acme/web": {
    "README.md": "# Web shop\n\nPages that use the calculator library.\n",
    "page.js": "import { add } from 'demo/math.js';\n\nexport const total = (a, b) => add(a, b);\n",
  },
};

const state = { issues: new Map(), comments: new Map(), events: new Map(), labels: new Map(), subIssues: [], pulls: [], nextIssue: 1, nextComment: 1 };
// Access the tests take away: repositories where the user has no write access (shown by the REST API), and
// repositories that refuse pushes (a pre-receive hook, as a token without write permission would).
const access = { noWrite: new Set(), pushRefused: new Set() };

const git = (args, cwd) => execFileSync("git", ["-c", "safe.directory=*", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function initRepo(slug) {
  const bare = join(GIT_ROOT, `${slug}.git`);
  if (existsSync(bare)) return;
  mkdirSync(bare, { recursive: true });
  git(["init", "--bare", "--initial-branch=main", bare]);
  const work = mkdtempSync(join(tmpdir(), "seed-"));
  git(["init", "--initial-branch=main", work]);
  for (const [file, content] of Object.entries(SEED[slug] ?? SEED["acme/demo"])) writeFileSync(join(work, file), content);
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
  id: i.id,
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

function createIssue(o, r, title, body, labels = []) {
  const number = state.nextIssue++;
  const key = issueKey(o, r, number);
  // The id is global (like GitHub's), the number is what people see.
  state.issues.set(key, { id: 9000 + number, number, title, body, state: "open", updatedAt: new Date().toISOString() });
  state.labels.set(key, new Set());
  state.comments.set(key, []);
  state.events.set(key, []);
  for (const label of labels) {
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
        return send(res, 201, { number: createIssue(o, r, b.title, b.body ?? "", b.labels ?? (b.label ? [b.label] : [])) });
      }
      if (m === "POST" && p[1] === "pulls" && p[3] === "merge") {
        const pr = state.pulls.find((x) => x.number === Number(p[2]));
        if (!pr) return send(res, 404, { message: "no pr" });
        // A real merge (fast-forward), so the next branch starts from the merged change.
        const bare = join(GIT_ROOT, `${pr.repo}.git`);
        git(["merge-base", "--is-ancestor", `refs/heads/${pr.base}`, `refs/heads/${pr.head}`], bare);
        git(["update-ref", `refs/heads/${pr.base}`, `refs/heads/${pr.head}`], bare);
        pr.state = "closed";
        pr.merged = true;
        return send(res, 200, pr);
      }
      if (m === "POST" && p[1] === "access") {
        const b = await readBody(req);
        const hook = join(GIT_ROOT, `${b.repo}.git`, "hooks", "pre-receive");
        if (b.write !== undefined) b.write ? access.noWrite.delete(b.repo) : access.noWrite.add(b.repo);
        if (b.push !== undefined) {
          if (b.push) {
            access.pushRefused.delete(b.repo);
            rmSync(hook, { force: true });
          } else {
            access.pushRefused.add(b.repo);
            writeFileSync(hook, `#!/bin/sh\necho "Permission to ${b.repo}.git denied to ${USER.login}." >&2\nexit 1\n`);
            chmodSync(hook, 0o755);
          }
        }
        return send(res, 200, { noWrite: [...access.noWrite], pushRefused: [...access.pushRefused] });
      }
      if (m === "GET" && p[1] === "state") {
        return send(res, 200, {
          issues: [...state.issues.entries()].map(([k, v]) => ({ k, ...v, labels: [...state.labels.get(k)] })),
          comments: Object.fromEntries(state.comments),
          subIssues: state.subIssues,
          pulls: state.pulls,
        });
      }
      if (m === "GET" && p[1] === "branch") {
        const [o, r] = (url.searchParams.get("repo") ?? REPOS[0]).split("/");
        const branch = url.searchParams.get("name");
        const bare = join(GIT_ROOT, `${o}/${r}.git`);
        // Against the pull request's base as it was when the branch was made (main may have moved on by a merge);
        // `base` names another branch for a stacked pull request.
        const base = git(["merge-base", url.searchParams.get("base") ?? "main", branch], bare).trim();
        const range = base === git(["rev-parse", branch], bare).trim() ? `${branch}~1..${branch}` : `${base}..${branch}`;
        const log = git(["log", "--format=%H %an <%ae> %s%n%b", range], bare);
        const files = git(["diff", "--name-only", range], bare);
        const commits = Number(git(["rev-list", "--count", range], bare).trim());
        return send(res, 200, { log, files: files.split("\n").filter(Boolean), commits });
      }
    }
    if (m === "GET" && url.pathname === "/user") return send(res, 200, USER);
    if (p[0] !== "repos") return send(res, 404, { message: `not found: ${m} ${url.pathname}` });
    const [, o, r, kind, n, sub, extra] = p;
    if (!REPOS.includes(`${o}/${r}`)) return send(res, 404, { message: "repo not found" });
    if (m === "GET" && !kind) {
      return send(res, 200, { default_branch: "main", full_name: `${o}/${r}`, permissions: { admin: false, push: !access.noWrite.has(`${o}/${r}`), pull: true } });
    }

    if (kind === "labels" && m === "POST") return send(res, 201, {});
    if (kind === "issues" && !n && m === "GET") {
      const label = url.searchParams.get("labels");
      const all = url.searchParams.get("state") === "all";
      const list = [...state.issues.entries()]
        .filter(([k, i]) => k.startsWith(`${o}/${r}#`) && (all || i.state === "open") && (!label || state.labels.get(k).has(label)))
        .map(([, i]) => issueJson(o, r, i));
      const etag = `"${createHash("sha1").update(JSON.stringify(list)).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) return send(res, 304, undefined, { etag });
      return send(res, 200, list, { etag });
    }
    if (kind === "issues" && !n && m === "POST") {
      const b = await readBody(req);
      const number = createIssue(o, r, b.title, b.body ?? "", b.labels ?? []);
      return send(res, 201, issueJson(o, r, state.issues.get(issueKey(o, r, number))));
    }
    const key = issueKey(o, r, n);
    if (kind === "issues" && n && !sub && m === "PATCH") {
      const i = state.issues.get(key);
      if (!i) return send(res, 404, { message: "no issue" });
      const b = await readBody(req);
      if (b.state) i.state = b.state;
      touch(o, r, n);
      return send(res, 200, issueJson(o, r, i));
    }
    // Sub-issues: the child is named by its global id and may live in another repository.
    if (kind === "issues" && sub === "sub_issues" && m === "POST") {
      const b = await readBody(req);
      const child = [...state.issues.entries()].find(([, i]) => i.id === b.sub_issue_id);
      if (!state.issues.has(key) || !child) return send(res, 404, { message: "no issue" });
      if (!state.subIssues.some((x) => x.parent === key && x.child === child[0])) state.subIssues.push({ parent: key, child: child[0] });
      return send(res, 201, issueJson(o, r, state.issues.get(key)));
    }
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
      const list = state.pulls.filter((x) => x.repo === `${o}/${r}` && (!head || x.head === head));
      return send(res, 200, list.map((x) => ({ ...x, merged_at: x.merged ? new Date().toISOString() : null })));
    }
    if (kind === "pulls" && !n && m === "POST") {
      const b = await readBody(req);
      const bare = join(GIT_ROOT, `${o}/${r}.git`);
      git(["rev-parse", "--verify", `refs/heads/${b.head}`], bare); // fails if the branch was not pushed
      const pr = { repo: `${o}/${r}`, number: state.pulls.length + 1, html_url: `https://github.example/${o}/${r}/pull/${state.pulls.length + 1}`, title: b.title, body: b.body, head: b.head, base: b.base, state: "open", merged: false };
      state.pulls.push(pr);
      return send(res, 201, pr);
    }
    if (kind === "pulls" && n && m === "GET") {
      const pr = state.pulls.find((x) => x.repo === `${o}/${r}` && x.number === Number(n));
      return pr ? send(res, 200, pr) : send(res, 404, { message: "no pr" });
    }
    // Retargeting: only an open pull request can move to another base branch, as on GitHub.
    if (kind === "pulls" && n && m === "PATCH") {
      const pr = state.pulls.find((x) => x.repo === `${o}/${r}` && x.number === Number(n));
      if (!pr) return send(res, 404, { message: "no pr" });
      const b = await readBody(req);
      if (b.base) {
        if (pr.state !== "open") return send(res, 422, { message: "Cannot change the base branch of a closed pull request." });
        pr.base = b.base;
        pr.retargeted = (pr.retargeted ?? 0) + 1;
      }
      return send(res, 200, pr);
    }
    return send(res, 404, { message: `not implemented: ${m} ${url.pathname}` });
  } catch (err) {
    console.error(err);
    return send(res, 500, { message: String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`fake-github on :${PORT} serving ${REPOS.join(", ")}`));
