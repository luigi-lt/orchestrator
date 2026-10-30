import { describe, expect, it } from "vitest";
import { Assessment, parseRepoSlug, sanitizeAgentComponents } from "./index.js";

describe("agent components", () => {
  it("drops system-only cards an agent tries to emit", () => {
    const out = sanitizeAgentComponents([
      { type: "text", markdown: "hi" },
      { type: "plan", runId: "r", approvalId: "a", hash: "h", plan: { summary: "s", subtasks: [] }, status: "pending" },
      { type: "approval", approvalId: "x" },
      { type: "table", columns: ["a"], rows: [["1"]] },
      { type: "form", id: "f" },
    ]);
    expect(out.map((c) => c.type)).toEqual(["text", "table"]);
  });
});

describe("repository slugs", () => {
  it("parses owner/name and rejects anything else", () => {
    expect(parseRepoSlug(" acme/demo ")).toEqual({ owner: "acme", name: "demo" });
    expect(() => parseRepoSlug("acme")).toThrow();
    expect(() => parseRepoSlug("a/b/c")).toThrow();
  });
});

describe("assessment schema", () => {
  it("accepts questions or a plan", () => {
    expect(Assessment.safeParse({ ready: false, questions: ["Why?"] }).success).toBe(true);
    expect(
      Assessment.safeParse({
        ready: true,
        questions: [],
        plan: { summary: "s", subtasks: [{ title: "Add it", description: "d", acceptanceCriteria: ["works"] }] },
      }).success,
    ).toBe(true);
  });
  it("rejects plans without sub-tasks", () => {
    expect(Assessment.safeParse({ ready: true, questions: [], plan: { summary: "s", subtasks: [] } }).success).toBe(false);
  });
});
