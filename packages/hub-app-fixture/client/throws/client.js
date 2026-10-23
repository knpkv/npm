// The fixture's failing client: mount throws, so the shell must show it unavailable.
export default {
  contract: 1,
  mount() {
    throw new Error("fixture mount failed")
  }
}
