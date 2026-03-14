/**
 * @title Permissions settings — manage per-operation permission states
 *
 * @module
 */
import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { permissionResetAtom, permissionsQueryAtom, permissionUpdateAtom } from "../atoms/app.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js"

export function SettingsPermissions() {
  const result = useAtomValue(permissionsQueryAtom)
  const update = useAtomSet(permissionUpdateAtom)
  const reset = useAtomSet(permissionResetAtom)

  const items = Result.isSuccess(result) ? result.value : []
  const reads = items.filter((p) => p.category === "read")
  const writes = items.filter((p) => p.category === "write")

  const allowAll = () => {
    for (const p of items) {
      if (p.state !== "always_allow") {
        update({ payload: { operation: p.operation, state: "always_allow" as const } })
      }
    }
  }

  const renderGroup = (label: string, group: typeof items) => (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">{label}</h4>
      {group.map((p) => (
        <div key={p.operation} className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant={p.category === "write" ? "destructive" : "secondary"} className="text-xs shrink-0">
              {p.category}
            </Badge>
            <div className="min-w-0">
              <code className="text-xs font-mono">{p.operation}</code>
              <p className="text-xs text-muted-foreground truncate">{p.description}</p>
            </div>
          </div>
          <Select
            value={p.state}
            onValueChange={(v) =>
              update({ payload: { operation: p.operation, state: v as "always_allow" | "allow" | "deny" } })
            }
          >
            <SelectTrigger className="w-36 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always_allow">Always Allow</SelectItem>
              <SelectItem value="allow">Ask Each Time</SelectItem>
              <SelectItem value="deny">Deny</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">API Permissions</h3>
        <p className="text-sm text-muted-foreground">Control which AWS API calls the app can make</p>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={allowAll}>
          Always Allow All
        </Button>
        <Button variant="outline" size="sm" onClick={() => reset({})}>
          Reset (Clear All)
        </Button>
      </div>

      {Result.isInitial(result) ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <div className="space-y-6">
          {renderGroup("Read Operations", reads)}
          {renderGroup("Write Operations", writes)}
        </div>
      )}
    </div>
  )
}
