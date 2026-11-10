import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import type { CatalogProduct } from "@orch/contracts";
import { api } from "../api";
import { useApp } from "../App";

/** Sub-navigation of the operator view. */
export function OpsNav() {
  return (
    <nav className="ops-nav">
      <NavLink to="/ops/runs">Runs</NavLink>
      <NavLink to="/ops/products">Products</NavLink>
    </nav>
  );
}

interface ProductsData {
  hash: string | null;
  products: CatalogProduct[];
  error: string | null;
}

/** The product catalog (FR-M1): read-only while it is a configuration file. */
export function Products() {
  const { setToggleTarget } = useApp();
  const [data, setData] = useState<ProductsData | null>(null);

  useEffect(() => {
    void api<ProductsData>("/api/products").then(setData);
    setToggleTarget("/chat");
    return () => setToggleTarget(null);
  }, [setToggleTarget]);

  if (!data) return <div className="page muted">Loading…</div>;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <OpsNav />
        </div>
        {data.hash && (
          <span className="muted small">
            Catalog version <code>{data.hash}</code> · edit <code>products.yaml</code> to change it; runs keep the version they started with
          </span>
        )}
      </div>
      {data.error && <div className="error-banner">{data.error}</div>}
      {data.products.map((p) => (
        <section key={p.id} className="panel product">
          <h2>
            {p.name} <code>{p.id}</code>
          </h2>
          <p>{p.description}</p>
          {p.owners.length > 0 && <p className="muted small">Owners: {p.owners.map((o) => `@${o}`).join(", ")}</p>}
          <table className="grid">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Role</th>
                <th>Sandbox image</th>
                <th>Commands</th>
                <th>Interfaces (contract paths)</th>
                <th>Extra high-risk paths</th>
              </tr>
            </thead>
            <tbody>
              {p.repositories.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.role}</td>
                  <td>{r.image}</td>
                  <td>
                    {Object.entries(r.commands).length
                      ? Object.entries(r.commands).map(([k, v]) => (
                          <div key={k}>
                            <span className="muted small">{k}:</span> <code>{v}</code>
                          </div>
                        ))
                      : "—"}
                  </td>
                  <td>{r.contractPaths.length ? r.contractPaths.map((x) => <code key={x}>{x}</code>) : "—"}</td>
                  <td>{r.highRiskPaths.length ? r.highRiskPaths.map((x) => <code key={x}>{x}</code>) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
