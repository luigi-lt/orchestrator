/**
 * Track rules (AD-32, FR-A2) and the catalog checks on an analysis. The analyst proposes;
 * these deterministic rules decide what is allowed, because the analysis is model output on untrusted input.
 */
import { classifyRisk, matchesAnyGlob } from "@orch/common";
import {
  findCatalogProduct,
  findCatalogRepository,
  workItemType,
  type Analysis,
  type Catalog,
  type CatalogRepository,
  type TrackDecision,
} from "@orch/contracts";

/** Splits "owner/name:path" as written by the analyst; a bare path belongs to no known repository. */
function splitLikelyFile(entry: string): { repo: string | null; path: string } {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):(.+)$/.exec(entry.trim());
  return m ? { repo: m[1]!, path: m[2]!.replace(/^\.?\//, "") } : { repo: null, path: entry.trim().replace(/^\.?\//, "") };
}

/** Problems that make an analysis unusable; returned to the analyst so it can correct itself. */
export function validateAnalysis(analysis: Analysis, catalog: Catalog): string[] {
  const errors: string[] = [];
  if (!analysis.ready) {
    if (analysis.questions.length === 0) errors.push("When ready is false you must ask at least one question.");
    return errors;
  }
  if (analysis.products.length === 0) errors.push("When ready is true, name at least one product that needs changes.");
  const seen = new Set<string>();
  for (const p of analysis.products) {
    const product = findCatalogProduct(catalog, p.product);
    if (!product) {
      errors.push(`Unknown product "${p.product}". Products in the catalog: ${catalog.products.map((x) => x.id).join(", ")}.`);
      continue;
    }
    if (seen.has(product.id)) errors.push(`Product "${product.id}" is listed twice; list each product once.`);
    seen.add(product.id);
    for (const slug of p.repositories) {
      const repo = findCatalogRepository(catalog, slug);
      if (!repo) errors.push(`Repository "${slug}" is not in the catalog.`);
      else if (repo.product !== product.id) errors.push(`Repository "${slug}" belongs to product "${repo.product}", not "${product.id}".`);
    }
  }
  return errors;
}

export interface TrackInput {
  analysis: Analysis;
  labels: readonly string[];
  catalog: Catalog;
  /** Fast-track limit on the number of files expected to change. */
  maxFiles: number;
}

/** Fast only when every rule allows it and the analyst proposes it; guided otherwise. */
export function decideTrack({ analysis: a, labels, catalog, maxFiles }: TrackInput): TrackDecision {
  const guided: string[] = [];
  const repositories = new Set(a.products.flatMap((p) => p.repositories.map((r) => r.toLowerCase())));
  if (a.products.length > 1) guided.push(`More than one product is involved (${a.products.map((p) => p.product).join(", ")})`);
  else if (repositories.size > 1) guided.push(`More than one repository is involved (${[...repositories].join(", ")})`);
  if (workItemType(labels) === "story") guided.push("The ticket is a story");
  if (a.size !== "S") guided.push(`The estimated size is ${a.size}`);
  if (!a.clearBehavior) guided.push("The expected behavior is not fully clear");
  if (!a.singleArea) guided.push("The change is not confined to one area");
  if (a.changesContracts) guided.push("A public API, schema or another interface between products changes");

  const files = a.likelyFiles.map(splitLikelyFile).filter((f) => f.path.includes(".") || f.path.includes("/"));
  const distinct = new Set(files.map((f) => `${f.repo ?? ""}:${f.path}`));
  if (distinct.size > maxFiles) guided.push(`About ${distinct.size} files are expected to change (the fast-track limit is ${maxFiles})`);
  const fallbackRepo = repositories.size === 1 ? [...repositories][0]! : null;
  for (const f of files) {
    const repo = findCatalogRepository(catalog, f.repo ?? fallbackRepo ?? "");
    if (repo && matchesAnyGlob(f.path, repo.contractPaths)) guided.push(`An interface of ${repo.product} is touched (${f.path})`);
    const risk = classifyRisk([f.path], repo?.highRiskPaths ?? []);
    if (risk.files.length) guided.push(`A high-risk file is touched (${f.path})`);
  }

  if (guided.length) return { track: "guided", proposed: a.proposedTrack, reasons: [...new Set(guided)] };
  if (a.proposedTrack === "guided") {
    return { track: "guided", proposed: "guided", reasons: a.trackReasons.length ? a.trackReasons : ["The analyst proposed the guided track"] };
  }
  return {
    track: "fast",
    proposed: "fast",
    reasons: ["Clear behavior, one area of one product, size S, no interface or high-risk file", ...a.trackReasons],
  };
}

/**
 * The fast-track limits, checked again on the finished change (FR-A2): the analysis is an estimate.
 * High-risk files are not listed here; they have their own approval before anything is pushed.
 */
export function fastTrackLimitsExceeded(changedFiles: readonly string[], repository: CatalogRepository | undefined, maxFiles: number): string[] {
  const reasons: string[] = [];
  if (changedFiles.length > maxFiles) reasons.push(`The change touches ${changedFiles.length} files (the fast-track limit is ${maxFiles})`);
  const contracts = repository ? changedFiles.filter((f) => matchesAnyGlob(f, repository.contractPaths)) : [];
  if (contracts.length) reasons.push(`The change touches an interface of ${repository!.product} (${contracts.join(", ")})`);
  return reasons;
}
