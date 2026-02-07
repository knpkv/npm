import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon } from "lucide-react"
import { useCallback, useEffect } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { openPrAtom } from "../atoms/app.js"
import { selectedPrAtom, viewAtom } from "../atoms/ui.js"
import { useDismissable } from "../hooks/useDismissable.js"
import { StorageKeys } from "../storage-keys.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js"
import { Separator } from "./ui/separator.js"

export function PRDetail() {
  const pr = useAtomValue(selectedPrAtom)
  const setView = useAtomSet(viewAtom)
  const openPr = useAtomSet(openPrAtom)
  const granted = useDismissable(StorageKeys.grantedDismissed)

  const proceedOpen = useCallback(() => {
    if (!pr) return
    openPr({ payload: { profile: pr.account.id, link: pr.link } })
  }, [openPr, pr])

  const handleOpen = useCallback(() => {
    if (!pr) return
    if (!granted.show()) {
      proceedOpen()
    }
  }, [granted, pr, proceedOpen])

  const handleGrantedContinue = () => {
    granted.dismiss()
    proceedOpen()
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        setView("prs")
      } else if ((e.key === "Enter" || e.key === "o") && pr?.link) {
        handleOpen()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleOpen, pr, setView])

  if (!pr) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <p className="text-sm">No PR selected</p>
      </div>
    )
  }

  const mergeBadge = !pr.isMergeable ? (
    <Badge variant="destructive">Conflict</Badge>
  ) : (
    <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
      Mergeable
    </Badge>
  )

  const approvalBadge = pr.isApproved ? (
    <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
      Approved
    </Badge>
  ) : (
    <Badge variant="secondary">Pending</Badge>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setView("prs")}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <div className="ml-auto">
          <Button size="sm" onClick={handleOpen}>
            <ExternalLinkIcon className="size-4" />
            Open in Console
          </Button>
        </div>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">{pr.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {mergeBadge}
          {approvalBadge}
          <Badge variant="outline">{pr.status}</Badge>
          <span className="text-sm text-muted-foreground">
            {pr.author} · {DateUtils.formatDate(pr.creationDate)}
          </span>
        </div>
      </div>

      <Separator />

      <Card>
        <CardContent className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 py-4 text-sm">
          <span className="text-muted-foreground">Repository</span>
          <span className="font-mono text-xs">{pr.repositoryName}</span>

          <span className="text-muted-foreground">Branch</span>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {pr.sourceBranch}
            </Badge>
            <ArrowRightIcon className="size-3 text-muted-foreground" />
            <Badge variant="outline" className="font-mono text-xs">
              {pr.destinationBranch}
            </Badge>
          </div>

          <span className="text-muted-foreground">ID</span>
          <span className="font-mono text-xs">{pr.id}</span>
        </CardContent>
      </Card>

      {pr.description && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Description</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <Markdown remarkPlugins={[remarkGfm]}>{pr.description}</Markdown>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={granted.visible} onOpenChange={granted.cancel}>
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
                onChange={(e) => granted.setDontRemind(e.target.checked)}
                className="accent-primary"
              />
              Don't remind again
            </label>
            <Button variant="ghost" onClick={granted.cancel}>
              Cancel
            </Button>
            <Button onClick={handleGrantedContinue}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
