import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { cn } from "../lib/utils.js"
import { useTheme } from "./theme-provider.js"
import { Separator } from "./ui/separator.js"

export function SettingsTheme() {
  const { setTheme, theme } = useTheme()

  const options = [
    { id: "light" as const, label: "Light", icon: <SunIcon className="size-5" /> },
    { id: "dark" as const, label: "Dark", icon: <MoonIcon className="size-5" /> },
    { id: "system" as const, label: "System", icon: <MonitorIcon className="size-5" /> }
  ]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Theme</h2>
        <p className="text-sm text-muted-foreground">Choose your preferred appearance</p>
      </div>
      <Separator />
      <div className="grid grid-cols-3 gap-3">
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setTheme(opt.id)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors",
              theme === opt.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
            )}
          >
            {opt.icon}
            <span className="text-sm font-medium">{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
