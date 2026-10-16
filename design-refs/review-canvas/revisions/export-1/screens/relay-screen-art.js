/* Screen art for the export-harness pages. Loads after relay-chef-modern.js and relay-creature-states.js.
 *   <relay-agent agent="coord" host="atlas" state="waiting" stale="false" size="52" family="Teal"></relay-agent>
 *   <relay-chef size="32"></relay-chef>          the Relay chef mark (M2), toque allowed
 *   <relay-glyph name="home" size="19"></relay-glyph>   interface glyphs (paths copied from relay-creature.js)
 *   RelayScreenArt.assignFamilies([{ host, id }, …]) → { "host:id": "Teal", … }
 * Agents: body shape hashed from host + agent (circle, squircle, pear, star, bean); hue family hashed the
 * same way, next free family on a collision within a host; Plum is reserved for the Relay chef.
 * Rows and cards: lids and brows only, no mouth, no accessory, no toque. A mouth is drawn only when
 * talking="true" (a talking stage creature). */
(() => {
const hash = (text) => {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
};
// Same OKLCH → sRGB recipe and lightness/chroma steps as relay-chef-modern.js, at another hue.
const hex = (L, C, H) => {
  const h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return '#' + rgb.map((v) => { v = Math.max(0, Math.min(1, v)); v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(v * 255).toString(16).padStart(2, '0'); }).join('');
};
const lin3 = (L, C, H) => {
  const h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, q = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q];
};
const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);
// Connect: hex with in-gamut chroma reduction.
const ghex = (L, C, H) => { let c = C; while (c > 0 && !inGamut(lin3(L, c, H))) c = Math.max(0, c - 0.002); return hex(L, c, H); };
const lum = (hx) => { const v = [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const CANVAS_LIGHT = ghex(0.9737, 0.0026, 286.35), WHITE = "#ffffff", CANVAS_DARK = ghex(0.1779, 0.0064, 271.04), SURFACE_DARK = ghex(0.2097, 0.008, 274.53);
// rev6 Connect agent families [key, name, hue, chroma k]. Plum (330) is reserved for the chef and never assigned.
const FAMILIES = [["rose", "Rose", 12, 0.16], ["ember", "Ember", 48, 0.15], ["amber", "Amber", 80, 0.13], ["lime", "Lime", 122, 0.14], ["moss", "Moss", 155, 0.13], ["teal", "Teal", 192, 0.11], ["sky", "Sky", 238, 0.13], ["iris", "Iris", 280, 0.15]];
const FAMILY = Object.fromEntries(FAMILIES.map(([key, name, H, k]) => [key, { key, name, H, k }]));
const palCache = {};
const palette = (fam) => {
  if (palCache[fam.key]) return palCache[fam.key];
  const { H, k } = fam;
  let L = 0.6, base = ghex(L, k, H);
  while (Math.min(contrast(base, CANVAS_LIGHT), contrast(base, WHITE)) < 3 && L > 0.4) { L = +(L - 0.01).toFixed(2); base = ghex(L, k, H); }
  while (Math.min(contrast(base, CANVAS_DARK), contrast(base, SURFACE_DARK)) < 3 && L < 0.75) { L = +(L + 0.01).toFixed(2); base = ghex(L, k, H); }
  return (palCache[fam.key] = {
    p78: hex(0.78, 0.11, H + 6), p30: hex(0.3, 0.09, H - 4),
    w: '#ffffff', w2: hex(0.955, 0.01, H - 10), w3: hex(0.89, 0.022, H - 15), w4: hex(0.74, 0.04, H - 15),
    p26: ghex(0.25, k * 0.45, H), p36: ghex(0.36, k * 0.7, H), p46: ghex(L - 0.12, k * 0.92, H - 3), p54: ghex(L - 0.05, k, H - 2),
    p58: base, p62: ghex(L + 0.04, k * 0.95, H), p70: ghex(L + 0.13, k * 0.8, H + 2),
    blush: ghex(0.74, 0.12, H + 22), sclera: ghex(0.985, 0.006, H), ring: base,
  });
};
const fnv = (key) => { let hh = 2166136261; for (const ch of key) { hh ^= ch.charCodeAt(0); hh = Math.imul(hh, 16777619); } return hh >>> 0; };
const SEEDS = ["circle", "squircle", "pear", "star", "bean"];
// Like Connect: i = fnv(host:id) % 8, then the next free family on that host, in the order agents are first drawn.
const hostUsed = {}, hostOf = {};
const pick = (host, id) => {
  const key = host + ":" + id; if (hostOf[key]) return hostOf[key];
  const used = (hostUsed[host] = hostUsed[host] || new Set());
  let i = fnv(key) % 8;
  for (let n = 0; n < 8 && used.has(FAMILIES[i][0]); n++) i = (i + 1) % 8;
  used.add(FAMILIES[i][0]);
  return (hostOf[key] = FAMILIES[i][0]);
};
const assignFamilies = (list) => { const out = {}; for (const { host, id } of list) out[host + ":" + id] = pick(host, id); return out; };
// Lids and brows only; working gets level lids, blocked worried brows, done arc eyes. Stale: heavy lids.
const POSE = {
  waiting: { brow: "idle" }, "needs-you": { brow: "idle" },
  blocked: { brow: "worried", eyeS: 1.1 }, error: { brow: "worried", eyeS: 1.1 },
  working: { brow: "focus", lid: 0.38, lidFlat: true, look: [-0.2, 0.8] },
  done: { brow: "up", eyes: "arc" }, ready: { brow: "idle" }, idle: { brow: "idle" }, closed: { brow: "idle", lid: 0.96, lidFlat: true },
};
const RING = { waiting: "solid", "needs-you": "solid", blocked: "solid", error: "solid", working: "dash" };
const TONE = { waiting: "held", "needs-you": "held", blocked: "blocked", error: "blocked", working: "deploying", done: "success" };
let seq = 0;
const on = (v) => v !== null && v !== "false";
class RelayAgent extends HTMLElement {
  static get observedAttributes() { return ["agent", "host", "state", "stale", "size", "family", "talking"]; }
  connectedCallback() { this.paint(); }
  attributeChangedCallback() { if (this.isConnected) this.paint(); }
  paint() {
    const id = this.getAttribute("agent") || "agent", host = this.getAttribute("host") || "host", state = this.getAttribute("state") || "ready";
    const size = Number(this.getAttribute("size")) || 44, stale = on(this.getAttribute("stale")), talking = on(this.getAttribute("talking"));
    const attr = this.getAttribute("family"), fam = attr && FAMILY[attr.toLowerCase()] ? attr.toLowerCase() : pick(host, id);
    const sig = [id, host, state, size, stale, fam, talking].join("|");
    if (sig === this._sig || !window.RelayCreatureStates) return;
    this._sig = sig;
    const hh = fnv(host + ":" + id);
    const seed = SEEDS[(hh >>> 8) % 5];
    const pose = Object.assign({}, POSE[state] || POSE.ready, stale ? { brow: "sleepy", lid: 0.5, eyes: undefined } : {});
    const ring = RING[state] && !stale ? { stroke: "currentColor", width: 1, dash: RING[state] === "dash" ? "22 78" : "" } : null;
    const tone = TONE[state];
    this.style.cssText = `display:block;flex:none;inline-size:${size}px;block-size:${size}px;line-height:0;color:${tone ? `var(--rly-color-${tone}-ink)` : "currentColor"};${stale || state === "closed" ? "opacity:.55;filter:saturate(.35)" : ""}`;
    this.dataset.shape = seed; this.dataset.family = fam;
    this.innerHTML = window.RelayCreatureStates.draw(Object.assign({
      seed, size, lvl: size < 64 ? 1 : size < 128 ? 2 : 3, idp: "ra" + (++seq), pal: palette(FAMILY[fam]),
      acc: "none", toque: false, ring, vb: "-6 -6 44 44", mouth: talking ? "closed" : undefined,
    }, pose));
  }
}
class RelayChef extends HTMLElement {
  static get observedAttributes() { return ["size"]; }
  connectedCallback() { this.paint(); }
  attributeChangedCallback() { if (this.isConnected) this.paint(); }
  paint() {
    const size = Number(this.getAttribute("size")) || 32;
    if (this._s === size || !window.RelayChefModern) return;
    this._s = size;
    this.style.cssText = `display:block;flex:none;inline-size:${size}px;block-size:${size}px;line-height:0`;
    this.innerHTML = window.RelayChefModern.draw("m2", { size, idp: "rc" + (++seq) });
  }
}
const paths = {
  loader: "M12 3a9 9 0 1 1-9 9", clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", alert: "M12 3 2 21h20L12 3zM12 10v5M12 18h.01",
  minus: "M6 12h12", check: "m5 12 5 5 9-10", x: "M6 6l12 12M18 6 6 18",
  home: "m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10",
  fleet: "M7 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6M1 22v-3a5 5 0 0 1 10 0v3M14 16a4 4 0 0 1 8 2v4",
  code: "M7 3v12a4 4 0 0 0 4 4h3M17 7v8M7 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M17 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M17 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  delivery: "M3 7h18v13H3zM7 7V3h10v4M3 12h18M10 12v3h4v-3",
  time: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l4 2",
  usage: "M4 20V12M10 20V4M16 20V8M22 20H2",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  arrow: "m9 5 7 7-7 7",
  offline: "m3 3 18 18M8 5a7 7 0 0 1 12 7M4 8a7 7 0 0 0 8 12M9 9l6 6",
  shield: "m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5l8-3M8 11l3 3 5-6",
  doc: "M6 2h8l4 4v16H6zM14 2v5h4M9 12h6M9 16h6",
  stacks: "m12 2 10 5-10 5L2 7zM2 12l10 5 10-5M2 17l10 5 10-5",
  host: "M6 6h12v12H6zM10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
};
class RelayGlyph extends HTMLElement {
  static get observedAttributes() { return ["name", "size"]; }
  connectedCallback() { this.paint(); }
  attributeChangedCallback() { if (this.isConnected) this.paint(); }
  paint() {
    const px = Number(this.getAttribute("size")) || 19.2, name = this.getAttribute("name") || "minus";
    if (this._sig === name + "|" + px) return;
    this._sig = name + "|" + px;
    this.style.cssText = `display:block;flex:none;inline-size:${px}px;block-size:${px}px;overflow:hidden;line-height:0`;
    this.innerHTML = `<svg viewBox="0 0 24 24" width="${px}" height="${px}" style="display:block;inline-size:${px}px;block-size:${px}px;max-inline-size:none" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.minus}"/></svg>`;
  }
}
window.RelayScreenArt = { assignFamilies, families: FAMILIES.map(([n]) => n), reserved: "Plum" };
if (!customElements.get("relay-agent")) customElements.define("relay-agent", RelayAgent);
if (!customElements.get("relay-chef")) customElements.define("relay-chef", RelayChef);
if (!customElements.get("relay-glyph")) customElements.define("relay-glyph", RelayGlyph);
})();
