import { copyFile } from "node:fs/promises"

// Keep the host stylesheet outside the views directory that Vite empties during its build.
await copyFile(
  new URL("../src/client/host-code.css", import.meta.url),
  new URL("../dist/host-code.css", import.meta.url)
)
