export const nextConnectAgentIndex = (key: string, currentIndex: number, count: number): number | null => {
  if (count === 0) return null
  switch (key) {
    case "ArrowDown":
    case "j":
      return (currentIndex + 1) % count
    case "ArrowUp":
    case "k":
      return (currentIndex - 1 + count) % count
    case "Home":
      return 0
    case "End":
      return count - 1
    default:
      return null
  }
}
