/**
 * @title Audit settings — enable/disable audit log + retention config
 *
 * @module
 */
import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { auditClearAtom, auditSettingsQueryAtom, updateAuditSettingsAtom } from "../atoms/app.js"
import { Button } from "./ui/button.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js"

export function SettingsAudit() {
  const navigate = useNavigate()
  const result = useAtomValue(auditSettingsQueryAtom)
  const save = useAtomSet(updateAuditSettingsAtom)
  const clearAudit = useAtomSet(auditClearAtom)
  const [enabled, setEnabled] = useState(true)
  const [retentionDays, setRetentionDays] = useState(30)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (Result.isSuccess(result)) {
      setEnabled(result.value.enabled)
      setRetentionDays(result.value.retentionDays)
      setDirty(false)
    }
  }, [result])

  const handleSave = () => {
    save({ payload: { enabled, retentionDays } })
    setDirty(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Audit Log</h3>
        <p className="text-sm text-muted-foreground">Record every AWS API call made by the app</p>
      </div>

      <div className="space-y-4">
        <label className="flex items-center justify-between rounded-md border px-3 py-3">
          <div>
            <p className="text-sm font-medium">Enable audit logging</p>
            <p className="text-xs text-muted-foreground">Log all API calls with permission state and duration</p>
          </div>
          <button
            role="switch"
            aria-checked={enabled}
            onClick={() => {
              setEnabled(!enabled)
              setDirty(true)
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              enabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`pointer-events-none block size-4 rounded-full bg-background shadow-lg transition-transform ${
                enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </label>

        <div className="rounded-md border px-3 py-3 space-y-2">
          <label className="text-sm font-medium">Retention period (days)</label>
          <p className="text-xs text-muted-foreground">Entries older than this are pruned on server start</p>
          <Select
            value={String(retentionDays)}
            onValueChange={(v) => {
              setRetentionDays(Number(v))
              setDirty(true)
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 days</SelectItem>
              <SelectItem value="14">14 days</SelectItem>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="60">60 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
              <SelectItem value="180">180 days</SelectItem>
              <SelectItem value="365">365 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0 rounded-md border w-fit">
          <Button size="sm" disabled={!dirty} onClick={handleSave} className="rounded-r-none border-0">
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/audit")}
            className="rounded-l-none border-0 border-l"
          >
            View Audit Log
          </Button>
        </div>
        <Button variant="destructive" size="sm" onClick={() => clearAudit({})}>
          Clear All Logs
        </Button>
      </div>
    </div>
  )
}
