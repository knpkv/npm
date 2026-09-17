export type TerminalRailNavigationKey = "ArrowLeft" | "ArrowRight"

/** Find the next enabled terminal control for horizontal toolbar navigation. */
export const nextTerminalRailIndex = (
  key: string,
  currentIndex: number,
  enabled: ReadonlyArray<boolean>
): number | null => {
  if ((key !== "ArrowLeft" && key !== "ArrowRight") || enabled.length < 2) return null
  const offset = key === "ArrowLeft" ? -1 : 1
  for (let step = 1; step < enabled.length; step += 1) {
    const index = (currentIndex + offset * step + enabled.length) % enabled.length
    if (enabled[index] === true) return index
  }
  return null
}
