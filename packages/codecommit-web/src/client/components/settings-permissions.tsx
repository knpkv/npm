/**
 * @title Permissions settings — manage per-operation permission states + audit config
 *
 * @module
 */
import { useCallback, useEffect, useState } from "react"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js"

interface PermissionEntry {
  readonly operation: string
  readonly state: "always_allow" | "allow" | "deny"
  readonly category: "read" | "write"
  readonly description: string
}

export function SettingsPermissions() {
  const [permissions, setPermissions] = useState<ReadonlyArray<PermissionEntry>>([])
  const [loading, setLoading] = useState(true)

  const fetchPermissions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/permissions/")
      setPermissions((await res.json()) as ReadonlyArray<PermissionEntry>)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPermissions()
  }, [fetchPermissions])

  const updatePermission = useCallback(
    async (operation: string, state: string) => {
      await fetch("/api/permissions/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, state })
      })
      await fetchPermissions()
    },
    [fetchPermissions]
  )

  const resetAll = useCallback(async () => {
    await fetch("/api/permissions/reset", { method: "POST" })
    await fetchPermissions()
  }, [fetchPermissions])

  const allowAll = useCallback(async () => {
    for (const p of permissions) {
      if (p.state !== "always_allow") {
        await fetch("/api/permissions/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: p.operation, state: "always_allow" })
        })
      }
    }
    await fetchPermissions()
  }, [permissions, fetchPermissions])

  const reads = permissions.filter((p) => p.category === "read")
  const writes = permissions.filter((p) => p.category === "write")

  const renderGroup = (label: string, items: ReadonlyArray<PermissionEntry>) => (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">{label}</h4>
      {items.map((p) => (
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
          <Select value={p.state} onValueChange={(v) => updatePermission(p.operation, v)}>
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
        <Button variant="outline" size="sm" onClick={resetAll}>
          Reset (Clear All)
        </Button>
      </div>

      {loading ? (
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
