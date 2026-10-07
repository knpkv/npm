/** Vitest (Vite) resolves `?raw` imports to the file's text; tests import stylesheets this way. */
declare module "*?raw" {
  const content: string
  export default content
}
