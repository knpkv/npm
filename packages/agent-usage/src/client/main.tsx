/**
 * The browser entry point.
 *
 * @module
 */
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import "./usage.css"

const root = document.getElementById("root")
if (root === null) throw new Error("agent-usage could not find its mount point")

createRoot(root).render(<App />)
