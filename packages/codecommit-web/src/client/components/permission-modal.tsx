/**
 * @title Permission prompt modal — asks user to allow/deny an AWS API call
 *
 * Appears when the server pushes a `permissionPrompt` via SSE.
 * Three actions: Allow Once, Always Allow, Deny.
 * POSTs response to /api/permissions/respond.
 * Dismissed automatically when SSE removes the prompt (other tab responded).
 *
 * @module
 */
import { ShieldCheckIcon } from "lucide-react"
import { useCallback, useState } from "react"
import type { AppState } from "../atoms/app.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js"

type PermissionResponse = "allow_once" | "always_allow" | "deny"

export function PermissionModal({ prompt }: { prompt: NonNullable<AppState["permissionPrompt"]> }) {
  const [loading, setLoading] = useState(false)

  const respond = useCallback(
    async (response: PermissionResponse) => {
      setLoading(true)
      try {
        await fetch("/api/permissions/respond", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: prompt.id, response })
        })
      } finally {
        setLoading(false)
      }
    },
    [prompt.id]
  )

  return (
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5" />
            API Permission Required
          </DialogTitle>
          <DialogDescription>{prompt.context}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
          <Badge variant={prompt.category === "write" ? "destructive" : "secondary"}>{prompt.category}</Badge>
          <code className="text-xs font-mono">{prompt.operation}</code>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={loading} onClick={() => respond("deny")}>
            Deny
          </Button>
          <Button variant="secondary" disabled={loading} onClick={() => respond("allow_once")}>
            Allow Once
          </Button>
          <Button disabled={loading} onClick={() => respond("always_allow")}>
            Always Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
