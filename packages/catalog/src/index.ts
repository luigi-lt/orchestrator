/**
 * Product catalog (AD-30, FR-M1): trusted configuration that says what each product owns, where its
 * code lives and how agents may work on it. Loaded from a YAML file, validated, and pinned by each run.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { config, hashOf } from "@orch/common";
import { Catalog, type CatalogProduct, type CatalogRepository } from "@orch/contracts";

export * from "./track.js";

/** Sandbox images a repository can ask for. One image exists locally; a JDK is a build option of it. */
export const WORKSPACE_IMAGES = ["general"] as const;

const Slug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/name");
const ProductId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be lowercase letters, digits and dashes");

const Settings = z
  .object({
    image: z.enum(WORKSPACE_IMAGES).optional(),
    commands: z.object({ setup: z.string().optional(), build: z.string().optional(), test: z.string().optional() }).strict().optional(),
    highRiskPaths: z.array(z.string().min(1)).optional(),
    contractPaths: z.array(z.string().min(1)).optional(),
    egress: z.array(z.string().min(1)).optional(),
  })
  .strict();

const RepositoryEntry = Settings.extend({ id: Slug, role: z.string().min(1).default("service") }).strict();

const ProductEntry = z
  .object({
    id: ProductId,
    name: z.string().min(1),
    description: z.string().min(1),
    owners: z.array(z.string().min(1)).default([]),
    defaults: Settings.optional(),
    repositories: z.array(RepositoryEntry).min(1),
  })
  .strict();

const CatalogFile = z.object({ products: z.array(ProductEntry).min(1) }).strict();

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** Parses and validates catalog YAML. Throws a CatalogError that names every problem. */
export function parseCatalog(text: string, source = "products.yaml"): Catalog {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new CatalogError(`${source} is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = CatalogFile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new CatalogError(`${source} is invalid:\n- ${issues.join("\n- ")}`);
  }

  const problems: string[] = [];
  const productIds = new Set<string>();
  const repoOwners = new Map<string, string>();
  const products: CatalogProduct[] = parsed.data.products.map((p) => {
    if (productIds.has(p.id)) problems.push(`product "${p.id}" is defined twice`);
    productIds.add(p.id);
    const repositories: CatalogRepository[] = p.repositories.map((r) => {
      const key = r.id.toLowerCase();
      const other = repoOwners.get(key);
      if (other) problems.push(`repository ${r.id} belongs to both "${other}" and "${p.id}"; a repository belongs to exactly one product`);
      repoOwners.set(key, p.id);
      const [owner, name] = r.id.split("/") as [string, string];
      const d = p.defaults ?? {};
      return {
        id: r.id,
        owner,
        name,
        product: p.id,
        role: r.role,
        image: r.image ?? d.image ?? "general",
        commands: { ...d.commands, ...r.commands },
        highRiskPaths: unique([...(d.highRiskPaths ?? []), ...(r.highRiskPaths ?? [])]),
        contractPaths: unique([...(d.contractPaths ?? []), ...(r.contractPaths ?? [])]),
        egress: unique([...(d.egress ?? []), ...(r.egress ?? [])]),
      };
    });
    return { id: p.id, name: p.name, description: p.description.trim(), owners: p.owners, repositories };
  });
  if (problems.length) throw new CatalogError(`${source} is invalid:\n- ${problems.join("\n- ")}`);
  return Catalog.parse({ hash: hashOf(products), products });
}

/** One product per repository: what the MVP's plain repository list meant. */
export function catalogFromRepositories(slugs: string[]): Catalog {
  const used = new Set<string>();
  const products = slugs.map((slug) => {
    const name = slug.split("/")[1] ?? slug;
    let id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "product";
    for (let n = 2; used.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    used.add(id);
    return { id, name, description: `Everything in the repository ${slug}.`, repositories: [{ id: slug }] };
  });
  return parseCatalog(JSON.stringify({ products }), "GITHUB_REPOS");
}

/**
 * Loads the catalog from PRODUCTS_FILE. Without a file, falls back to one product per repository
 * of the legacy GITHUB_REPOS setting, so an MVP configuration keeps working.
 */
export function loadCatalog(): Catalog {
  const file = config.productsFile();
  if (existsSync(file) && statSync(file).isFile()) return parseCatalog(readFileSync(file, "utf8"), file);
  const legacy = config.githubRepos().filter((s) => s !== "owner/repo");
  if (legacy.length) return catalogFromRepositories(legacy);
  throw new CatalogError(`No product catalog found at ${file}. Create products.yaml (see products.example.yaml) and run ./bin/orchestrator up again.`);
}

let cached: { key: string; catalog: Catalog } | undefined;

/**
 * The catalog as it is on disk now, re-read when the file changes. New runs pin this version;
 * an invalid file throws, so nothing new starts until it is fixed (running runs keep their pinned version).
 */
export function currentCatalog(): Catalog {
  const file = config.productsFile();
  const key = existsSync(file) && statSync(file).isFile() ? `${file}:${statSync(file).mtimeMs}:${statSync(file).size}` : `legacy:${config.githubRepos().join(",")}`;
  if (cached?.key !== key) cached = { key, catalog: loadCatalog() };
  return cached.catalog;
}
