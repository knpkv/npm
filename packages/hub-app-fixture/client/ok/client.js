// The fixture's client: one line naming the page and the caller. Plain ESM, no build.
export default {
  contract: 1,
  mount(root, context) {
    const render = (current) => {
      root.textContent = `Fixture ${current.page} for ${current.caller.login}`
    }
    render(context)
    return { update: render, unmount: () => root.replaceChildren() }
  }
}
