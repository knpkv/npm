import { useKeyboard } from "@opentui/react"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { Dialog } from "./Dialog.js"

/**
 * Explains the one prerequisite the console action cannot work around.
 *
 * Reaching the console requires a federated session, which only Granted's
 * `assume` produces here, so there is nothing to retry until it is installed.
 * The dialog is therefore informational: it names the missing executable, points
 * at the install, and shows the destination link so the attempt is not lost. The
 * link is rendered rather than only announced as copied, because the clipboard
 * copy is best-effort: a host without `pbcopy` or `xclip` reports that
 * separately and still reaches this dialog.
 */
export function DialogAssumeRequired({ link, profile }: { readonly link: string; readonly profile: string }) {
  const { theme } = useTheme()
  const dialog = useDialog()

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "return") dialog.hide()
  })

  return (
    <Dialog title="GRANTED REQUIRED">
      <text fg={theme.textError}>The assume executable was not found on PATH.</text>
      <box flexDirection="column" style={{ paddingBottom: 1, paddingTop: 1 }}>
        <text fg={theme.textMuted}>
          {`Opening the console signs in as ${profile}, which needs Granted's assume command.`}
        </text>
        <text fg={theme.textMuted}>Install it from https://granted.dev, then run this action again.</text>
      </box>
      <text fg={theme.text}>The console link, copied when a clipboard tool exists:</text>
      <box style={{ paddingBottom: 1 }}>
        <text fg={theme.textAccent}>{link}</text>
      </box>
      <text fg={theme.textAccent}>Enter or Esc close</text>
    </Dialog>
  )
}
