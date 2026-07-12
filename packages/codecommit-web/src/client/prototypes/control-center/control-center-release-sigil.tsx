const symbols: ReadonlyArray<string> = ["🦕", "🔥", "🍄", "🛰️", "🐙", "⚡", "🌙", "🪐", "🦊", "🌊", "🐝", "🌵"]
const colors: ReadonlyArray<string> = ["#e8f1ff", "#fff0dc", "#eee8ff", "#e5f7ec", "#ffe8e5", "#e8f7fa"]
const adjectives: ReadonlyArray<string> = ["Ember", "Orbit", "Moss", "Nova", "Tidal", "Copper", "Lunar", "Wild"]
const nouns: ReadonlyArray<string> = ["Dino", "Grove", "Comet", "Reef", "Fox", "Bloom", "Beacon", "Hive"]

const valueAt = (values: ReadonlyArray<string>, index: number): string => values[index] ?? values[0] ?? ""

const hashString = (value: string) => {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export interface ReleaseIdentity {
  readonly codename: string
  readonly symbols: readonly [string, string, string]
}

export const releaseIdentity = (service: string): ReleaseIdentity => {
  const hash = hashString(service)
  const first = hash % symbols.length
  let second = (hash >>> 7) % symbols.length
  let third = (hash >>> 15) % symbols.length
  if (second === first) second = (second + 1) % symbols.length
  while (third === first || third === second) third = (third + 1) % symbols.length
  return {
    codename: `${valueAt(adjectives, (hash >>> 3) % adjectives.length)} ${valueAt(
      nouns,
      (hash >>> 11) % nouns.length
    )}`,
    symbols: [valueAt(symbols, first), valueAt(symbols, second), valueAt(symbols, third)]
  }
}

export function ReleaseSigil({
  service,
  size = "compact"
}: {
  readonly service: string
  readonly size?: "compact" | "hero"
}) {
  const identity = releaseIdentity(service)
  return (
    <div className={`cc-release-identity ${size}`}>
      <svg
        aria-label={`${identity.codename} release sigil: ${identity.symbols.join(", ")}`}
        className="cc-release-sigil"
        role="img"
        viewBox="0 0 82 34"
      >
        {identity.symbols.map((symbol, index) => (
          <g key={`${symbol}-${index}`} transform={`translate(${index * 24 + 1} 1)`}>
            <rect
              fill={valueAt(colors, (hashString(service) + index * 3) % colors.length)}
              height="32"
              rx="10"
              width="32"
            />
            <text dominantBaseline="central" fontSize="17" textAnchor="middle" x="16" y="17">
              {symbol}
            </text>
          </g>
        ))}
      </svg>
      <div>
        <small>RELEASE SIGIL</small>
        <b>{identity.codename}</b>
      </div>
    </div>
  )
}
