/**
 * The browser entry point.
 *
 * @module
 */
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import "./week.css"

const root = document.getElementById("root")
if (root === null) throw new Error("jcf-web could not find its mount point")

createRoot(root).render(<App />)
