import { KeyboardIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js"
import { Separator } from "./ui/separator.js"

const SHORTCUTS = [
  { key: "Esc", desc: "Back / Close" },
  { key: "R", desc: "Refresh PRs" },
  { key: "/", desc: "Filter PRs" },
  { key: "1-7", desc: "Quick filters" },
  { key: "Enter", desc: "Open PR details" },
  { key: "Cmd+P", desc: "Command palette" }
]

export function SettingsAbout() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">About</h2>
        <p className="text-sm text-muted-foreground">Keyboard shortcuts and info</p>
      </div>
      <Separator />
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center gap-2">
            <KeyboardIcon className="size-4" />
            <CardTitle className="text-sm">Keyboard Shortcuts</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pb-3">
          <div className="space-y-1">
            {SHORTCUTS.map((s) => (
              <div key={s.key} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{s.desc}</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{s.key}</kbd>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
