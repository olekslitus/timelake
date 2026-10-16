import SETTINGS from "@/lib/settings.json"

/** One setting as `timelake settings --json` prints it (generated from the registry in timelake-format). */
type Setting = {
  name: string
  property: string
  sql: string
  kind: string
  default: { value?: string; unset?: string; derived?: string }
  levels: string[]
  since: string
  description: string
}

/** Text with `code` spans. */
function Text({ children }: { children: string }) {
  return children.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))
}

/** Every setting in the registry: name (the property is `timelake.<name>`), default, where it can be set, and what it does. */
export function SettingsTable() {
  return (
    <table>
      <thead>
        <tr>
          <th>Setting</th>
          <th>Default</th>
          <th>Set at</th>
          <th>Meaning</th>
        </tr>
      </thead>
      <tbody>
        {(SETTINGS as Setting[]).map((s) => {
          const d = s.default
          return (
            <tr key={s.name} id={s.name}>
              <td className="whitespace-nowrap">
                <code>{s.name}</code>
                <div className="mt-1 text-xs text-muted-foreground">
                  {s.kind}, since {s.since}
                </div>
              </td>
              <td>{d.value !== undefined ? <code>{d.value}</code> : (d.unset ?? d.derived)}</td>
              <td className="whitespace-nowrap">
                {s.levels.length ? s.levels.map((l) => <div key={l}>{l}</div>) : "Timelake"}
              </td>
              <td>
                <Text>{s.description}</Text>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
