const { document, fetch } = globalThis
document.documentElement.style.colorScheme = globalThis.__designFixtureIdentity.theme === "dark" ? "dark" : "light"
const response = await fetch("/fixture.json")
if (!response.ok) throw new Error(`Fixture returned ${response.status}`)
const fixture = await response.json()
const state = globalThis.__designFixtureIdentity.state
document.querySelector("h1").textContent = fixture.data.heading
document.querySelector("p").textContent = state === "copy" || state === "waived"
  ? "Changed workspace"
  : fixture.data.detail
if (state === "geometry") document.querySelector("main").style.transform = "translateX(8px)"
if (state === "token") document.querySelector("main").style.color = "oklch(50% 0.2 25)"
if (state === "pixel" || state === "legacy") document.querySelector("circle").setAttribute("fill", "oklch(50% 0.2 250)")
document.documentElement.dataset.designReady = "true"
