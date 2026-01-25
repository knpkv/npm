import { useTheme } from "../context/theme.js"

interface StatusRowProps {
  readonly label: string
  readonly children: React.ReactNode
}

/**
 * Renders a label and content row for details view
 * @category components
 */
export function StatusRow({ children, label }: StatusRowProps) {
  const { theme } = useTheme()

  return (
    <box flexDirection="row" style={{ paddingBottom: 1, alignItems: "center" }}>
      <box style={{ width: 12 }}>
        <text fg={theme.textMuted}>{label}</text>
      </box>
      {children}
    </box>
  )
}
