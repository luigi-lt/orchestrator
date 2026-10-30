import { describe, expect, it } from "vitest";
import { classifyRisk, isHostAllowed, scanDiffForSecrets } from "./safety.js";
import { signWorkspaceToken, verifyWorkspaceToken } from "./tokens.js";
import { canonicalJson, hashOf, slugify } from "./util.js";

describe("secret scanning", () => {
  const diff = [
    "diff --git a/config.js b/config.js",
    "+++ b/config.js",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    `+const token = "ghp_${"a".repeat(36)}";`,
    `-const old = "sk-ant-${"b".repeat(30)}";`,
  ].join("\n");

  it("flags secrets on added lines with file and line", () => {
    expect(scanDiffForSecrets(diff)).toEqual([{ file: "config.js", line: 2, kind: "GitHub token" }]);
  });

  it("ignores removed lines and clean diffs", () => {
    expect(scanDiffForSecrets("+++ b/a.ts\n@@ -1 +1 @@\n+const x = 42;\n")).toEqual([]);
  });

  it("detects private keys", () => {
    expect(scanDiffForSecrets("+++ b/key.pem\n@@ -0,0 +1 @@\n+-----BEGIN RSA PRIVATE KEY-----\n")[0]?.kind).toBe("Private key");
  });
});

describe("risk classification", () => {
  it("marks CI, infrastructure and dependency changes as high risk", () => {
    const r = classifyRisk(["src/app.ts", ".github/workflows/ci.yml", "package.json", "Dockerfile", "build.gradle.kts"]);
    expect(r.files).toEqual([".github/workflows/ci.yml", "package.json", "Dockerfile", "build.gradle.kts"]);
    expect(r.reasons).toEqual(
      expect.arrayContaining(["Changes CI/CD configuration", "Changes dependencies", "Changes infrastructure or container definitions"]),
    );
  });

  it("leaves ordinary source changes alone", () => {
    expect(classifyRisk(["src/app.ts", "README.md", "test/app.test.ts"])).toEqual({ reasons: [], files: [] });
  });
});

describe("egress allowlist", () => {
  const allow = ["registry.npmjs.org", "pypi.org"];
  it("allows listed hosts and their subdomains", () => {
    expect(isHostAllowed("registry.npmjs.org", allow)).toBe(true);
    expect(isHostAllowed("files.pypi.org", allow)).toBe(true);
    expect(isHostAllowed("REGISTRY.NPMJS.ORG.", allow)).toBe(true);
  });
  it("blocks everything else, including look-alikes", () => {
    expect(isHostAllowed("evil.com", allow)).toBe(false);
    expect(isHostAllowed("registry.npmjs.org.evil.com", allow)).toBe(false);
    expect(isHostAllowed("notpypi.org", allow)).toBe(false);
  });
});

describe("workspace tokens", () => {
  const secret = "test-secret";
  it("round-trips the step id", () => {
    const token = signWorkspaceToken("run_x-s1", 60, secret);
    expect(verifyWorkspaceToken(token, secret)).toEqual({ stepId: "run_x-s1" });
  });
  it("rejects tampered, foreign and expired tokens", () => {
    const token = signWorkspaceToken("run_x-s1", 60, secret);
    const [step, exp, sig] = token.split(".");
    const forged = `${Buffer.from("run_y-s9").toString("base64url")}.${exp}.${sig}`;
    expect(verifyWorkspaceToken(forged, secret)).toBeNull();
    expect(verifyWorkspaceToken(`${step}.${exp}.${sig}x`, secret)).toBeNull();
    expect(verifyWorkspaceToken(token, "other-secret")).toBeNull();
    const expired = signWorkspaceToken("run_x-s1", 60, secret, Date.now() - 120_000);
    expect(verifyWorkspaceToken(expired, secret)).toBeNull();
  });
});

describe("hashing and slugs", () => {
  it("hashes independently of key order", () => {
    expect(hashOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(canonicalJson({ b: 1, a: undefined, c: null })).toBe('{"b":1,"c":null}');
  });
  it("detects any change to a plan", () => {
    const plan = { summary: "s", subtasks: [{ title: "t", description: "d", acceptanceCriteria: [] }] };
    expect(hashOf(plan)).not.toBe(hashOf({ ...plan, summary: "s2" }));
  });
  it("builds branch-safe slugs", () => {
    expect(slugify("Fix: Crash on Ünicode input!!")).toBe("fix-crash-on-unicode-input");
    expect(slugify("***")).toBe("change");
  });
});
