import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import "./index.css"

import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router"
import { ThemeProvider } from "./components/theme-provider.js"
import { router } from "./router.js"

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  override render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <button onClick={() => window.location.reload()} style={{ marginTop: "1rem" }}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const root = document.getElementById("root")
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ErrorBoundary>
    </React.StrictMode>
  )
}
