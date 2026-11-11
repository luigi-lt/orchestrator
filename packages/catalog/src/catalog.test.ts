import { describe, expect, it } from "vitest";
import type { Analysis } from "@orch/contracts";
import { CatalogError, catalogFromRepositories, decideTrack, fastTrackLimitsExceeded, parseCatalog, validateAnalysis } from "./index.js";

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

  it("checks an analysis against the catalog", () => {
    expect(validateAnalysis(base, catalog)).toEqual([]);
    expect(validateAnalysis({ ...base, products: [] }, catalog)[0]).toMatch(/at least one product/);
    expect(validateAnalysis({ ...base, products: [{ ...base.products[0]!, product: "nope" }] }, catalog)[0]).toMatch(/Unknown product/);
    expect(validateAnalysis({ ...base, products: [{ ...base.products[0]!, repositories: ["acme/web"] }] }, catalog)[0]).toMatch(/belongs to product "shop"/);
    expect(validateAnalysis({ ...base, ready: false }, catalog)[0]).toMatch(/at least one question/);
  });
});
