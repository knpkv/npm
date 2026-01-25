import { Component, type ReactNode } from "react"

interface Props {
  readonly children: ReactNode
}

interface State {
  readonly error: Error | null
}

/**
 * Catches rendering errors and displays a fallback UI
 * @category components
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} />
    }
    return this.props.children
  }
}

function ErrorFallback({ error }: { readonly error: Error }) {
  // Use hardcoded colors for error state to ensure visibility regardless of theme breakage
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#2D3748"
      }}
    >
      <box style={{ backgroundColor: "#880000", padding: 1, flexDirection: "column" }}>
        <text fg="#FFFFFF" style={{ fontWeight: "bold" } as any}>
          CRITICAL ERROR
        </text>
        <text fg="#FFFFFF">{error.message}</text>
        <text fg="#A0AEC0">{error.stack}</text>
      </box>
    </box>
  )
}
