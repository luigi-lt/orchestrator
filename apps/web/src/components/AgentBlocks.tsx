import { useState } from "react";
import type { AgentComponent } from "@orch/contracts";

type Table = Extract<AgentComponent, { type: "table" }>;
type Form = Extract<AgentComponent, { type: "form" }>;

export function TableBlock({ table }: { table: Table }) {
  return (
    <div className="table-wrap">
      {table.title && <div className="block-title">{table.title}</div>}
      <table>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FormBlock({ form, onSubmit }: { form: Form; onSubmit: (title: string | undefined, values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const set = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }));
  const missing = form.fields.some((f) => f.required && !values[f.name]?.trim());
  return (
    <form
      className="form-block"
      onSubmit={(e) => {
        e.preventDefault();
        setSent(true);
        onSubmit(form.title, values);
      }}
    >
      {form.title && <div className="block-title">{form.title}</div>}
      {form.fields.map((f) => (
        <label key={f.name} className="field">
          <span>
            {f.label}
            {f.required ? " *" : ""}
          </span>
          {f.kind === "textarea" ? (
            <textarea value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} disabled={sent} rows={3} />
          ) : f.kind === "choice" ? (
            <select value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} disabled={sent}>
              <option value="">Choose…</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} disabled={sent} />
          )}
        </label>
      ))}
      <button className="primary" type="submit" disabled={sent || missing}>
        {sent ? "Sent" : (form.submitLabel ?? "Submit")}
      </button>
    </form>
  );
}
