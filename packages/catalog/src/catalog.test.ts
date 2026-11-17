import { describe, expect, it } from "vitest";
import { buildOrder, diffPlans, type Analysis, type HandoffPlan } from "@orch/contracts";
import { CatalogError, catalogFromRepositories, decideTrack, fastTrackLimitsExceeded, parseCatalog, validateAnalysis, validateHandoffPlan } from "./index.js";

const YAML = `
products:
  - id: calc
    name: Calculator library
    description: Owns the arithmetic functions.
    owners: [alice]
    defaults:
      commands: { test: "npm test" }
      highRiskPaths: ["deploy/**"]
    repositories:
      - id: acme/demo
        role: library
        contractPaths: ["index.d.ts", "api/**"]
  - id: shop
    name: Web shop
    description: Owns the web pages that use the calculator.
    repositories:
      - id: acme/web
        commands: { test: "npm run test:web" }
      - id: acme/web-tools
        role: tooling
`;

describe("product catalog", () => {
  const catalog = parseCatalog(YAML);

  it("resolves defaults per repository and gives the catalog a stable hash", () => {
    const demo = catalog.products[0]!.repositories[0]!;
    expect(demo).toMatchObject({ id: "acme/demo", owner: "acme", name: "demo", product: "calc", role: "library", image: "general" });
    expect(demo.commands.test).toBe("npm test");
    expect(demo.highRiskPaths).toEqual(["deploy/**"]);
    expect(catalog.products[1]!.repositories[0]!.commands.test).toBe("npm run test:web");
    expect(catalog.products[1]!.repositories[1]!.role).toBe("tooling");
    expect(parseCatalog(YAML).hash).toBe(catalog.hash);
  });

  it("rejects a repository in two products, duplicate ids and unknown keys", () => {
    const twice = "products:\n  - {id: a, name: A, description: d, repositories: [{id: x/y}]}\n  - {id: b, name: B, description: d, repositories: [{id: X/Y}]}";
    expect(() => parseCatalog(twice)).toThrow(/exactly one product/);
    const dup = "products:\n  - {id: a, name: A, description: d, repositories: [{id: x/y}]}\n  - {id: a, name: B, description: d, repositories: [{id: x/z}]}";
    expect(() => parseCatalog(dup)).toThrow(/defined twice/);
    const unknown = "products:\n  - {id: a, name: A, description: d, tools: [shell], repositories: [{id: x/y}]}";
    expect(() => parseCatalog(unknown)).toThrow(CatalogError);
    expect(() => parseCatalog("products: [")).toThrow(/not valid YAML/);
  });

  it("builds one product per repository from a plain repository list", () => {
    const c = catalogFromRepositories(["acme/demo", "other/demo"]);
    expect(c.products.map((p) => p.id)).toEqual(["demo", "demo-2"]);
  });

  const base: Analysis = {
    ready: true,
    questions: [],
    understanding: "Add subtract next to add",
    products: [{ product: "calc", repositories: ["acme/demo"], reason: "owns arithmetic", changes: "new function" }],
    likelyFiles: ["acme/demo:subtract.js"],
    risks: [],
    assumptions: [],
    acceptanceCriteria: ["subtract(5, 3) returns 2"],
    size: "S",
    clearBehavior: true,
    singleArea: true,
    changesContracts: false,
    proposedTrack: "fast",
    trackReasons: ["One small function"],
    approach: "Create subtract.js",
  };
  const decide = (analysis: Analysis, labels: string[] = []) => decideTrack({ analysis, labels, catalog, maxFiles: 5 });

  it("keeps the fast track only when every rule allows it", () => {
    expect(decide(base).track).toBe("fast");
    expect(decide({ ...base, proposedTrack: "guided" }).track).toBe("guided");
    expect(decide(base, ["Story"]).reasons[0]).toMatch(/story/);
    expect(decide({ ...base, size: "M" }).track).toBe("guided");
    expect(decide({ ...base, changesContracts: true }).track).toBe("guided");
    expect(decide({ ...base, likelyFiles: ["acme/demo:api/v1.yaml"] }).reasons.join()).toMatch(/interface of calc/);
    expect(decide({ ...base, likelyFiles: ["acme/demo:deploy/prod.yaml"] }).reasons.join()).toMatch(/high-risk/);
    expect(decide({ ...base, likelyFiles: ["acme/demo:.github/workflows/ci.yml"] }).track).toBe("guided");
    expect(decide({ ...base, likelyFiles: ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"] }).reasons.join()).toMatch(/6 files/);
  });

  it("always chooses guided for more than one product, whatever the analyst proposes", () => {
    const two = { ...base, products: [...base.products, { product: "shop", repositories: ["acme/web"], reason: "r", changes: "c" }] };
    const d = decide(two);
    expect(d).toMatchObject({ track: "guided", proposed: "fast" });
    expect(d.reasons[0]).toMatch(/More than one product/);
  });

  it("checks the fast-track limits again on the real change", () => {
    const demo = catalog.products[0]!.repositories[0]!;
    expect(fastTrackLimitsExceeded(["subtract.js", "test.js"], demo, 5)).toEqual([]);
    expect(fastTrackLimitsExceeded(["a", "b", "c", "d", "e", "f"], demo, 5)[0]).toMatch(/6 files/);
    expect(fastTrackLimitsExceeded(["api/v2.yaml"], demo, 5)[0]).toMatch(/interface of calc \(api\/v2.yaml\)/);
    expect(fastTrackLimitsExceeded(["a", "b"], undefined, 1)).toHaveLength(1);
  });

  const plan: HandoffPlan = {
    goal: "Show discounts",
    approach: "Add the field, then show it",
    outOfScope: [],
    risks: [],
    assumptions: [],
    constraints: ["Do not change add()"],
    definitionOfDone: [],
    contracts: [{ name: "discount field", description: "number, optional", providers: ["api"], consumers: ["page"] }],
    rollout: "library first",
    subtasks: [
      { key: "page", title: "Show the discount", description: "d", acceptanceCriteria: ["shown"], product: "shop", repository: "acme/web", likelyFiles: [], dependsOn: ["api"], size: "S" },
      { key: "api", title: "Add the discount field", description: "d", acceptanceCriteria: ["returned"], product: "calc", repository: "acme/demo", likelyFiles: [], dependsOn: [], size: "S" },
    ],
  };

  it("accepts a plan whose sub-tasks each change one catalog repository, and orders them by their dependencies", () => {
    expect(validateHandoffPlan(plan, catalog)).toEqual([]);
    expect(buildOrder(plan)!.map((st) => st.key)).toEqual(["api", "page"]);
  });

  it("sends back a plan with unknown products, wrong repositories, bad dependencies or contracts without sides", () => {
    const st = plan.subtasks[1]!;
    const problems = (subtasks: HandoffPlan["subtasks"], contracts = plan.contracts) => validateHandoffPlan({ ...plan, subtasks, contracts }, catalog).join(" | ");
    expect(problems([plan.subtasks[0]!, { ...st, product: "nope" }])).toMatch(/unknown product "nope"/);
    expect(problems([plan.subtasks[0]!, { ...st, repository: "acme/web" }])).toMatch(/belongs to product "shop", not "calc"/);
    expect(problems([plan.subtasks[0]!, { ...st, repository: "acme/other" }])).toMatch(/not in the catalog/);
    expect(problems([plan.subtasks[0]!, { ...st, key: "page" }])).toMatch(/used twice/);
    // "change" is the single change of the fast track, which a run that switched tracks holds already.
    expect(problems([plan.subtasks[0]!, { ...st, key: "change" }])).toMatch(/"change" is reserved/);
    expect(problems([plan.subtasks[0]!, { ...st, key: "change-3" }])).toMatch(/"change-3" is reserved/);
    expect(problems([plan.subtasks[0]!, { ...st, key: "change-log" }])).not.toMatch(/reserved/);
    expect(problems([plan.subtasks[0]!, { ...st, dependsOn: ["page"] }])).toMatch(/form a cycle/);
    expect(problems([{ ...plan.subtasks[0]!, dependsOn: ["gone"] }, st])).toMatch(/not a sub-task of this plan/);
    expect(problems(plan.subtasks, [{ ...plan.contracts[0]!, consumers: [] }])).toMatch(/must name the sub-tasks/);
  });

  it("says what changed between two plan versions, matching sub-tasks by key", () => {
    expect(diffPlans(null, plan)).toEqual([]);
    expect(diffPlans(plan, plan)).toEqual([]);
    const next: HandoffPlan = {
      ...plan,
      constraints: [...plan.constraints, "Keep it under 50 lines"],
      contracts: [],
      subtasks: [
        { ...plan.subtasks[1]!, title: "Add the discount field to the result", size: "M" },
        { ...plan.subtasks[0]!, key: "docs", title: "Document the discount", dependsOn: [] },
      ],
    };
    expect(diffPlans(plan, next)).toEqual([
      { kind: "changed", what: "plan", title: "Constraints" },
      { kind: "changed", what: "subtask", title: "Add the discount field to the result", fields: ["title", "size"] },
      { kind: "added", what: "subtask", title: "Document the discount" },
      { kind: "removed", what: "subtask", title: "Show the discount" },
      { kind: "removed", what: "contract", title: "discount field" },
    ]);
  });

  it("checks an analysis against the catalog", () => {
    expect(validateAnalysis(base, catalog)).toEqual([]);
    expect(validateAnalysis({ ...base, products: [] }, catalog)[0]).toMatch(/at least one product/);
    expect(validateAnalysis({ ...base, products: [{ ...base.products[0]!, product: "nope" }] }, catalog)[0]).toMatch(/Unknown product/);
    expect(validateAnalysis({ ...base, products: [{ ...base.products[0]!, repositories: ["acme/web"] }] }, catalog)[0]).toMatch(/belongs to product "shop"/);
    expect(validateAnalysis({ ...base, ready: false }, catalog)[0]).toMatch(/at least one question/);
  });
});
