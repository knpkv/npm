import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import "./index.css"

import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router"
import { ThemeProvider } from "./components/theme-provider.js"
import { router } from "./router.js"

const root = document.getElementById("root")
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </React.StrictMode>
  )
}
