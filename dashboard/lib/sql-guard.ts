/**
 * The console is read-only. DataFusion can write files (COPY TO, INSERT INTO external tables), and
 * EXPLAIN ANALYZE executes its statement, so only single read statements without write keywords pass.
 */
export function readOnlyError(query: string): string | null {
  const statements = query.split(";").map((s) => s.trim()).filter(Boolean)
  if (statements.length !== 1) return "Run one statement at a time."
  const stmt = statements[0].replace(/--[^\n]*/g, "").trim()
  const first = stmt.split(/\s+/)[0]?.toUpperCase() ?? ""
  if (!["SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "VALUES"].includes(first)) {
    return "The console is read-only: use SELECT, WITH, EXPLAIN, SHOW or DESCRIBE."
  }
  if (/\b(COPY|INSERT|CREATE|DROP|DELETE|UPDATE|ALTER|SET)\b/i.test(stmt)) {
    return "The console is read-only."
  }
  return null
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
