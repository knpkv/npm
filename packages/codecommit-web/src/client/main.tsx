import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./components/App/index.js"
import "./theme.css"

const root = document.getElementById("root")
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
