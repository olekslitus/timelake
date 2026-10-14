/**
 * Why a query can't run in the read-only console, or null if it can. DataFusion can write files (COPY TO, INSERT INTO
 * external tables), and EXPLAIN ANALYZE executes its statement, so only single read statements without write keywords
 * pass.
 */
export function readOnlyError(query: string): string | null {
  const statements = query
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
  const [statement] = statements
  if (statements.length !== 1 || statement === undefined) return "Run one statement at a time."
  const stmt = statement.replace(/--[^\n]*/g, "").trim()
  const first = stmt.split(/\s+/)[0]?.toUpperCase() ?? ""
  if (!["SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "VALUES"].includes(first)) {
    return "The console is read-only: use SELECT, WITH, EXPLAIN, SHOW or DESCRIBE."
  }
  if (/\b(COPY|INSERT|CREATE|DROP|DELETE|UPDATE|ALTER|SET)\b/i.test(stmt)) {
    return "The console is read-only."
  }
  return null
}

/** `my "col"` → `"my ""col"""`. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** `iot.readings` → `"iot"."readings"`. */
export function quoteTableName(name: string): string {
  return name.split(".").map(quoteIdent).join(".")
}

/** A number as is, a string in single quotes. */
export function quoteLiteral(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`
}
