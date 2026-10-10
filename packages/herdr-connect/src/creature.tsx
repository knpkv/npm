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
import { agentCharacter, FOOT, IRIS_SHARE } from "./character.js"

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

/** Lengths the stylesheet's keyframes read, in viewBox units. */
type Rig = Record<
  | "--connect-creature-blink"
  | "--connect-creature-lever"
  | "--connect-creature-lid"
  | "--connect-creature-lid-low"
  | "--connect-creature-pace"
  | "--connect-creature-phase",
  string
>

/** The agent's character, decorative and hidden from assistive technology. */
export const Creature = ({ arrived = false, host, id, size, stale = false, state }: CreatureProps): ReactElement => {
  const character = agentCharacter(host, id)
  const presentation = agentStatePresentation(state)
  const [light, mid, deep] = character.hues
  const [eyeWidth, eyeHeight] = character.eye
  const [left, top, width, height] = character.bounds
  const eyes = [50 - character.eyeGap, 50 + character.eyeGap]
  const eyeY = character.eyeY
  const iris = Math.min(eyeWidth, eyeHeight) * IRIS_SHARE
  // A lid's edge is a downward curve this deep; closed, both lids meet along it, 45% of the way down the eye.
  const sag = eyeHeight * 0.3
  const shut = eyeY + eyeHeight * 0.45
  // The lids cover the socket as well as the eye, so a shut eye is smooth skin and a lash, with no ring left.
  // At rest they sit clear of it, so no sliver of skin notches the eye.
  const socket = 1.2
  const upperRest = eyeY - eyeHeight - socket - 0.6
  const lowerRest = eyeY + eyeHeight + socket + 0.6
  const reach = eyeWidth + socket + 1
  // Multiples of the slow motion token, and lengths for the face to follow the body; the stylesheet reads both.
  const rig: CSSProperties & Rig = {
    "--connect-creature-blink": String(character.blink),
    // The face rides the body's squash: a stretch of s lifts it by (s - 1) times its height above the foot.
    "--connect-creature-lever": (FOOT - eyeY).toFixed(2),
    "--connect-creature-lid": (shut - upperRest).toFixed(2),
    "--connect-creature-lid-low": (shut - lowerRest).toFixed(2),
    "--connect-creature-pace": String(character.pace),
    "--connect-creature-phase": String(character.phase)
  }
  // Unique per drawn creature: ids built from host and ID could collide once cleaned (hosts "a.b" and "a_b"),
  // painting one creature with another's colours.
  const ref = `connect-creature-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const fixed = (value: number): string => value.toFixed(2)
  // An opening bounded on one side by a lid's sagging edge, reaching far past the eye on the other side; the
  // stylesheet moves the edge.
  const lid = (x: number, edge: number, above: boolean): string => {
    const from = x - reach
    const far = above ? edge - eyeHeight * 3.4 : edge + eyeHeight * 3.4
    return `M${fixed(from)} ${fixed(far)}V${fixed(edge - sag)}Q${fixed(x)} ${fixed(edge + sag)} ${fixed(x + reach)} ${fixed(edge - sag)}V${fixed(far)}Z`
  }
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
      style={rig}
      viewBox="0 0 100 100"
      width={pixels[size]}
    >
      <defs>
        <radialGradient cx="38%" cy="30%" id={`${ref}-body`} r="80%">
          <stop offset="0" stopColor={`oklch(0.86 0.12 ${String(light)})`} />
          <stop offset="0.55" stopColor={`oklch(0.66 0.17 ${String(light)})`} />
          <stop offset="1" stopColor={`oklch(0.46 0.17 ${String(mid)})`} />
        </radialGradient>
        {/* A gradient shadow: a blur filter on every row of a long list costs more. */}
        <radialGradient id={`${ref}-shadow`}>
          <stop offset="0" stopColor="black" stopOpacity="0.28" />
          <stop offset="1" stopColor="black" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${ref}-core`}>
          <stop offset="0" stopColor={`oklch(0.95 0.1 ${String(deep)})`} stopOpacity="0.95" />
          <stop offset="1" stopColor={`oklch(0.75 0.15 ${String(deep)})`} stopOpacity="0" />
        </radialGradient>
        {/* Light from the upper left: a soft gloss, and the underside turning away into shade. */}
        <radialGradient id={`${ref}-gloss`}>
          <stop offset="0" stopColor="white" stopOpacity="0.55" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${ref}-shade`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0.55" stopColor={`oklch(0.3 0.12 ${String(mid)})`} stopOpacity="0" />
          <stop offset="1" stopColor={`oklch(0.3 0.12 ${String(mid)})`} stopOpacity="0.45" />
        </linearGradient>
        {/* The white of the eye, rounder at its edge; the iris lit from below, as a lens is. */}
        <radialGradient cy="40%" id={`${ref}-white`} r="60%">
          <stop offset="0.6" stopColor={`oklch(0.99 0.006 ${String(deep)})`} />
          <stop offset="1" stopColor={`oklch(0.86 0.03 ${String(deep)})`} />
        </radialGradient>
        <radialGradient cy="72%" id={`${ref}-iris`} r="70%">
          <stop offset="0" stopColor={`oklch(0.62 0.15 ${String(deep)})`} />
          <stop offset="1" stopColor={`oklch(0.3 0.09 ${String(deep)})`} />
        </radialGradient>
        <clipPath id={`${ref}-skin`}>
          <path d={character.body} />
        </clipPath>
        {eyes.map((x, index) => (
          <clipPath id={`${ref}-eye-${String(index)}`} key={x}>
            <ellipse cx={x} cy={eyeY} rx={eyeWidth} ry={eyeHeight} />
          </clipPath>
        ))}
        {eyes.map((x, index) => (
          <clipPath id={`${ref}-socket-${String(index)}`} key={x}>
            <ellipse cx={x} cy={eyeY} rx={eyeWidth + socket} ry={eyeHeight + socket} />
          </clipPath>
        ))}
        {/*
         * The lids are an aperture, not paint: each eye shows only between its two lid edges, so as they close
         * the body itself shows through, with its own light and shade, and a shut eye is unbroken skin.
         */}
        {eyes.map((x, index) => (
          <clipPath id={`${ref}-upper-${String(index)}`} key={x}>
            <path className="connect-creature-lid" d={lid(x, upperRest, false)} />
          </clipPath>
        ))}
        {eyes.map((x, index) => (
          <clipPath id={`${ref}-lower-${String(index)}`} key={x}>
            <path className="connect-creature-lid" data-low="" d={lid(x, lowerRest, true)} />
          </clipPath>
        ))}
      </defs>
      <ellipse
        className="connect-creature-shadow"
        cx="50"
        cy={FOOT + 3}
        fill={`url(#${ref}-shadow)`}
        rx={fixed(width * 0.42)}
        ry="5"
      />
      <circle className="connect-creature-halo" cx="50" cy="55" r="46" />
      <circle className="connect-creature-orbit" cx="50" cy="55" pathLength="100" r="46" />
      {/* Body and face move apart: only the body squashes, and the face rides along without stretching. */}
      <g className="connect-creature-lean">
        <g className="connect-creature-squash">
          <g className="connect-creature-breath">
            <path className="connect-creature-body" d={character.body} fill={`url(#${ref}-body)`} />
            <g clipPath={`url(#${ref}-skin)`}>
              <circle
                className="connect-creature-core"
                cx="50"
                cy={fixed(FOOT - height * 0.28)}
                fill={`url(#${ref}-core)`}
                r="16"
              />
              <rect
                className="connect-creature-shade"
                fill={`url(#${ref}-shade)`}
                height={fixed(height)}
                width={fixed(width)}
                x={fixed(left)}
                y={fixed(top)}
              />
              <ellipse
                className="connect-creature-shine"
                cx={fixed(left + width * 0.3)}
                cy={fixed(top + height * 0.2)}
                fill={`url(#${ref}-gloss)`}
                rx={fixed(width * 0.17)}
                ry={fixed(height * 0.1)}
                transform={`rotate(-24 ${fixed(left + width * 0.3)} ${fixed(top + height * 0.2)})`}
              />
            </g>
          </g>
        </g>
        <g className="connect-creature-face">
          <g className="connect-creature-bob">
            {eyes.map((x, index) => (
              <g className="connect-creature-eye" key={x}>
                <g clipPath={`url(#${ref}-upper-${String(index)})`}>
                  <g clipPath={`url(#${ref}-lower-${String(index)})`}>
                    <ellipse
                      className="connect-creature-socket"
                      cx={x}
                      cy={eyeY}
                      rx={eyeWidth + socket}
                      ry={eyeHeight + socket}
                    />
                    <ellipse
                      className="connect-creature-white"
                      cx={x}
                      cy={eyeY}
                      fill={`url(#${ref}-white)`}
                      rx={eyeWidth}
                      ry={eyeHeight}
                    />
                    <g clipPath={`url(#${ref}-eye-${String(index)})`}>
                      <g className="connect-creature-gaze">
                        <circle
                          className="connect-creature-iris"
                          cx={x}
                          cy={eyeY}
                          fill={`url(#${ref}-iris)`}
                          r={iris}
                        />
                        <circle className="connect-creature-pupil" cx={x} cy={eyeY} r={fixed(iris * 0.52)} />
                        <circle
                          className="connect-creature-glint"
                          cx={fixed(x - iris * 0.36)}
                          cy={fixed(eyeY - iris * 0.4)}
                          r={fixed(iris * 0.26)}
                        />
                        <circle
                          className="connect-creature-glint"
                          data-small=""
                          cx={fixed(x + iris * 0.34)}
                          cy={fixed(eyeY + iris * 0.36)}
                          r={fixed(iris * 0.12)}
                        />
                      </g>
                    </g>
                  </g>
                </g>
                {/* The lash rides the upper lid's edge, and shows only while the lid is down. */}
                <g clipPath={`url(#${ref}-socket-${String(index)})`}>
                  <g className="connect-creature-lid">
                    <path
                      className="connect-creature-lash"
                      d={`M${fixed(x - reach)} ${fixed(upperRest - sag)}Q${fixed(x)} ${fixed(upperRest + sag)} ${fixed(x + reach)} ${fixed(upperRest - sag)}`}
                    />
                  </g>
                </g>
              </g>
            ))}
          </g>
        </g>
      </g>
    </svg>
  )
}
