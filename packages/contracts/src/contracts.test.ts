import { describe, expect, it } from "vitest";
import { findingsToFix, groupTickets, mergeReview, parseRepoSlug, sanitizeAgentComponents, type ReviewReport, type RunDto } from "./index.js";

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

describe("tickets group the runs of one issue", () => {
  const run = (id: string, ticketKey: string, state: RunDto["state"], createdAt: string, updatedAt = createdAt): RunDto => ({
    id,
    ticketKey,
    repo: "acme/demo",
    issueNumber: Number(ticketKey.split("#")[1]),
    title: `Title of ${id}`,
    url: "u",
    requester: "tester",
    state,
    conversationId: `conv_${id}`,
    branch: null,
    prNumber: null,
    prUrl: null,
    plan: null,
    track: "guided",
    trackReasons: [],
    homeProduct: "calc",
    products: ["calc"],
    analysis: null,
    catalogHash: null,
    error: null,
    createdAt,
    updatedAt,
  });
  const runs = [
    run("r1", "run:github:acme/demo#12", "cancelled", "2026-11-01T10:00:00Z"),
    run("r3", "run:github:acme/demo#12", "awaiting_approval", "2026-11-03T10:00:00Z"),
    run("r2", "run:github:acme/demo#9", "completed", "2026-11-02T10:00:00Z", "2026-11-02T12:00:00Z"),
  ];

  it("lists tickets by latest activity, their runs newest first, numbered in the order they started", () => {
    const tickets = groupTickets(runs, { r3: 1 });
    expect(tickets.map((t) => t.issueNumber)).toEqual([12, 9]);
    const twelve = tickets[0]!;
    expect(twelve.runs.map((r) => [r.runId, r.ordinal])).toEqual([
      ["r3", 2],
      ["r1", 1],
    ]);
    expect(twelve).toMatchObject({ state: "awaiting_approval", active: true, pending: 1, title: "Title of r3" });
    expect(tickets[1]).toMatchObject({ state: "completed", active: false, pending: 0 });
    expect(tickets[1]!.runs[0]!.conversationId).toBe("conv_r2");
  });

  it("returns nothing for no runs", () => {
    expect(groupTickets([])).toEqual([]);
  });
});

describe("review rounds", () => {
  const first: ReviewReport = {
    verdict: "approve", // the verdict word is not trusted; severities decide
    summary: "Works, with one gap",
    criteria: [{ criterion: "subtract(5, 3) returns 2", met: true }],
    findings: [
      { severity: "major", title: "No input check", file: "subtract.js", line: 1, explanation: "Strings are accepted" },
      { severity: "minor", title: "Missing comment", explanation: "Add a short doc comment" },
    ],
    earlier: [],
  };

  it("numbers findings per round and sends only blocking and major ones back to the implementer", () => {
    const review = mergeReview(null, first);
    expect(review.rounds).toBe(1);
    expect(review.open.map((f) => [f.id, f.round, f.severity])).toEqual([
      ["r1-1", 0, "major"],
      ["r1-2", 0, "minor"],
    ]);
    expect(findingsToFix(review).map((f) => f.id)).toEqual(["r1-1"]);
  });

  it("moves findings the next review confirms as fixed to resolved, and takes the newest report as what is open", () => {
    const second: ReviewReport = { ...first, summary: "Fixed", findings: [], earlier: [{ id: "r1-1", resolved: true }] };
    const review = mergeReview(mergeReview(null, first), second);
    expect(review).toMatchObject({ rounds: 2, summary: "Fixed", open: [] });
    expect(review.resolved.map((f) => f.id)).toEqual(["r1-1"]);
    expect(findingsToFix(review)).toEqual([]);
  });

  it("keeps a finding out of resolved when the reviewer says it is still there", () => {
    const again: ReviewReport = { ...first, findings: [first.findings[0]!], earlier: [{ id: "r1-1", resolved: false }] };
    const review = mergeReview(mergeReview(null, first), again);
    expect(review.resolved).toEqual([]);
    expect(review.open.map((f) => [f.id, f.round])).toEqual([["r2-1", 1]]);
  });
});
