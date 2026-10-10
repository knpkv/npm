/**
 * An agent drawn as its character: a soft body with eyes, seeded by host and stable ID.
 *
 * Its look never changes; its state, read through {@link agentStatePresentation}, sets only behaviour:
 * working agents read and a light travels round the body; one that needs you turns to look at you and
 * carries a halo in the state's tone; a ready agent glances around; a finished one rests, half-lidded; an
 * agent whose host stopped answering closes its eyes and holds still. The creature is decorative: the row's
 * words say the state.
 *
 * @module
 */
import { type CSSProperties, type ReactElement, useId } from "react"

import { agentStatePresentation } from "./agent-state.js"
import { agentCharacter } from "./character.js"

/** Where the creature is drawn, which sets its size. */
export type CreatureSize = "row" | "cast" | "stage"

const pixels = { cast: 60, row: 36, stage: 240 } satisfies Record<CreatureSize, number>

export interface CreatureProps {
  readonly host: string
  readonly id: string
  readonly state: string
  /** The agent's host stopped answering: the last known state shows, without life. */
  readonly stale?: boolean
  /** It started needing you on this poll: it turns to you once. */
  readonly arrived?: boolean
  readonly size: CreatureSize
}

/** The agent's character, decorative and hidden from assistive technology. */
export const Creature = ({ arrived = false, host, id, size, stale = false, state }: CreatureProps): ReactElement => {
  const character = agentCharacter(host, id)
  const presentation = agentStatePresentation(state)
  const [light, mid, deep] = character.hues
  const [eyeWidth, eyeHeight] = character.eye
  const eyes = [50 - character.eyeGap, 50 + character.eyeGap]
  // Unique per drawn creature: ids built from host and ID could collide once cleaned (hosts "a.b" and "a_b"),
  // painting one creature with another's colours.
  // Multiples of the slow motion token; the stylesheet turns them into durations.
  const rhythm: CSSProperties &
    Record<"--connect-creature-blink" | "--connect-creature-pace" | "--connect-creature-phase", string> = {
    "--connect-creature-blink": String(character.blink),
    "--connect-creature-pace": String(character.pace),
    "--connect-creature-phase": String(character.phase)
  }
  const gradient = `connect-creature-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  return (
    <svg
      aria-hidden="true"
      className="connect-creature"
      data-arrived={arrived ? "" : undefined}
      data-bucket={presentation.bucket}
      data-size={size}
      data-stale={stale ? "" : undefined}
      data-tone={presentation.tone}
      focusable="false"
      height={pixels[size]}
      style={rhythm}
      viewBox="0 0 100 100"
      width={pixels[size]}
    >
      <defs>
        <radialGradient cx="38%" cy="30%" id={`${gradient}-body`} r="80%">
          <stop offset="0" stopColor={`oklch(0.86 0.12 ${String(light)})`} />
          <stop offset="0.55" stopColor={`oklch(0.66 0.17 ${String(light)})`} />
          <stop offset="1" stopColor={`oklch(0.46 0.17 ${String(mid)})`} />
        </radialGradient>
        {/* A gradient shadow: a blur filter on every row of a long list costs more. */}
        <radialGradient id={`${gradient}-shadow`}>
          <stop offset="0" stopColor="black" stopOpacity="0.28" />
          <stop offset="1" stopColor="black" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${gradient}-core`}>
          <stop offset="0" stopColor={`oklch(0.95 0.1 ${String(deep)})`} stopOpacity="0.95" />
          <stop offset="1" stopColor={`oklch(0.75 0.15 ${String(deep)})`} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse className="connect-creature-shadow" cx="50" cy="92" fill={`url(#${gradient}-shadow)`} rx="30" ry="5" />
      <circle className="connect-creature-halo" cx="50" cy="55" r="46" />
      <circle className="connect-creature-orbit" cx="50" cy="55" pathLength="100" r="46" />
      <g className="connect-creature-lean">
        <g className="connect-creature-breath">
          <path className="connect-creature-body" d={character.body} fill={`url(#${gradient}-body)`} />
          <circle className="connect-creature-core" cx="50" cy="70" fill={`url(#${gradient}-core)`} r="16" />
          <ellipse className="connect-creature-shine" cx="37" cy="31" rx="8" ry="4.5" transform="rotate(-24 37 31)" />
          <g className="connect-creature-eyes">
            <g className="connect-creature-lids">
              {eyes.map((x) => (
                <ellipse
                  className="connect-creature-eye"
                  cx={x}
                  cy={character.eyeY}
                  key={x}
                  rx={eyeWidth}
                  ry={eyeHeight}
                />
              ))}
              <g className="connect-creature-gaze">
                {eyes.map((x) => (
                  <circle
                    className="connect-creature-pupil"
                    cx={x}
                    cy={character.eyeY + 0.6}
                    key={x}
                    r={Math.min(eyeWidth, eyeHeight) * 0.55}
                  />
                ))}
              </g>
            </g>
          </g>
          <g className="connect-creature-closed">
            {eyes.map((x) => (
              <path
                d={`M${String(x - eyeWidth)} ${String(character.eyeY)}q${String(eyeWidth)} ${String(eyeHeight * 0.8)} ${String(eyeWidth * 2)} 0`}
                key={x}
              />
            ))}
          </g>
        </g>
      </g>
    </svg>
  )
}
