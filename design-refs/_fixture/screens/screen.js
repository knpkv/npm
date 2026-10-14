const { URLSearchParams, document, fetch, location } = globalThis
const parameters = new URLSearchParams(location.search)
document.documentElement.style.colorScheme = parameters.get("theme") === "dark" ? "dark" : "light"
const response = await fetch("../fixture.json")
if (!response.ok) throw new Error(`Fixture returned ${response.status}`)
const fixture = await response.json()
document.querySelector("h1").textContent = fixture.data.heading
document.querySelector("p").textContent = fixture.data.detail
document.documentElement.dataset.designReady = "true"
