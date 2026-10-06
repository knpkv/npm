/**
 * @title SSO sign-out confirmation
 *
 * `aws sso logout` takes no profile: it ends every AWS SSO session on this machine, including the
 * ones other tools and agents use. Both sign-out entry points (the account menu and Accounts settings)
 * open this dialog first, so the scope is stated before anything is revoked. The result arrives as a
 * notification: success says what ended, failure says why.
 *
 * @module
 */
import { useAtomSet } from "@effect/atom-react"
import { LogOutIcon } from "lucide-react"
import { Link } from "react-router"
import { notificationsSsoLogoutAtom } from "../atoms/app.js"
import { Button } from "./ui/button.js"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js"

export function SsoSignOutDialog({
  onOpenChange,
  open
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const signOut = () => {
    ssoLogout({})
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogOutIcon className="size-5" />
            Sign out of AWS SSO on this machine?
          </DialogTitle>
          <DialogDescription>
            This runs <code className="font-mono text-xs">aws sso logout</code>, which signs out of AWS SSO for all
            profiles on this machine, including the sessions other tools and agents use. Profiles with static keys keep
            working.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          To stop using one account here instead, switch it off in{" "}
          <Link className="underline" onClick={() => onOpenChange(false)} to="/settings/accounts">
            Accounts
          </Link>
          .
        </p>
        <DialogFooter>
          <Button autoFocus onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button onClick={signOut} variant="destructive">
            Sign out of all profiles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
