import { Box } from "./Box"

export const Markdown = (props: any) => {
  // Simple pass-through for now
  return (
    <Box flexDirection="column" style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
      {props.children}
    </Box>
  )
}
