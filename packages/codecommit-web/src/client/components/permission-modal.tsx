/**
 * @title Permission prompt modal — asks user to allow/deny an AWS API call
 *
 * Appears when the server pushes a `permissionPrompt` via SSE.
 * Three actions: Allow Once, Always Allow, Deny.
 * Dismissed automatically when SSE removes the prompt (other tab responded).
 *
 * @module
 */
import { useAtomSet } from "@effect-atom/atom-react"
import { ShieldCheckIcon } from "lucide-react"
import type { AppState } from "../atoms/app.js"
import { permissionRespondAtom } from "../atoms/app.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js"

type PermissionResponse = "allow_once" | "always_allow" | "deny"

export function PermissionModal({ prompt }: { prompt: NonNullable<AppState["permissionPrompt"]> }) {
  const respond = useAtomSet(permissionRespondAtom)

  const handleRespond = (response: PermissionResponse) => respond({ payload: { id: prompt.id, response } })

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
          <Button variant="outline" onClick={() => handleRespond("deny")}>
            Deny
          </Button>
          <Button variant="secondary" onClick={() => handleRespond("allow_once")}>
            Allow Once
          </Button>
          <Button onClick={() => handleRespond("always_allow")}>Always Allow</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
