import { Button } from "./ui/button.js"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js"
import type { PRRequirementDialogsViewProps } from "./pr-detail-view.js"

export type { PRRequirementDialogsViewProps, PRRequirementDialogState } from "./pr-detail-view.js"

export function PRRequirementDialogsView({ docker, granted }: PRRequirementDialogsViewProps) {
  return (
    <>
      <Dialog open={granted.visible} onOpenChange={granted.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Granted CLI Required</DialogTitle>
            <DialogDescription>
              "Open in Console" uses{" "}
              <a
                href="https://docs.commonfate.io/granted/introduction"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Granted
              </a>{" "}
              to assume the AWS role for this account. Make sure the{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">assume</code> CLI is installed and
              configured before continuing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <label className="flex items-center gap-2 text-sm text-muted-foreground mr-auto">
              <input
                type="checkbox"
                checked={granted.dontRemind}
                onChange={(e) => granted.onDontRemindChange(e.target.checked)}
                className="accent-primary"
              />
              Don't remind again
            </label>
            <Button variant="ghost" onClick={granted.onCancel}>
              Cancel
            </Button>
            <Button onClick={granted.onContinue}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={docker.visible} onOpenChange={docker.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Docker Required</DialogTitle>
            <DialogDescription>
              Sandbox uses Docker to run a code-server container. Make sure Docker is started before continuing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <label className="flex items-center gap-2 text-sm text-muted-foreground mr-auto">
              <input
                type="checkbox"
                checked={docker.dontRemind}
                onChange={(e) => docker.onDontRemindChange(e.target.checked)}
                className="accent-primary"
              />
              Don't show again
            </label>
            <Button onClick={docker.onContinue}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
