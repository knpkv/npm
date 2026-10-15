/** Neutral role accessories follow the reference body contour and leave eyes clear. No chef headwear belongs here. */
import type { ReactElement } from "react"
import { creatureBodySeed, type BodyKind } from "./character.js"
import type { CreatureAccessory } from "./creature-state.js"

interface AccessoryProps {
  readonly accessory: CreatureAccessory
  readonly bodyKind: BodyKind
  readonly unit: number
  readonly top: number
  readonly foot: number
  readonly eyeY: number
  readonly eyeWidth: number
  readonly eyeHeight: number
  readonly eyeGap: number
  readonly skin: string
}

/** The motion group uses body coordinates; its child alone scales the reference artwork, so CSS pivots never shift that scale. */
export const CreatureAdornment = ({
  accessory,
  bodyKind,
  eyeGap,
  eyeHeight,
  eyeWidth,
  eyeY,
  foot,
  skin,
  top,
  unit
}: AccessoryProps): ReactElement | null => {
  if (accessory === "none") return null
  const width = creatureBodySeed(bodyKind).width
  const height = (foot - top) / unit
  const y = eyeY / unit
  const head = top / unit
  const centre = 50 / unit
  const left = centre - width / 2
  const side = (at: number, direction: number): number =>
    bodyKind === "pear"
      ? centre + direction * width * (0.28 + (0.22 * (at - head)) / height)
      : bodyKind === "squircle"
        ? centre + direction * (width / 2 - 0.2)
        : centre + direction * Math.sqrt(Math.max(0, (width / 2) ** 2 - (at - head - height / 2) ** 2))
  const graphite = "#2b2e37"
  const graphiteMid = "#4a4e5c"
  const graphiteLight = "#7a7f90"
  const eyes = [centre - eyeGap / unit, centre + eyeGap / unit]
  const frameWidth = (eyeWidth * 2) / unit + 1.9
  const frameHeight = (eyeHeight * 2) / unit + 1.5
  const cy = y + 0.5
  const lx = side(cy, -1)
  const rx = side(cy, 1)
  const brim = head + 2.2
  const scarfY = head + height * 0.83
  const knot = centre + width * 0.22
  return (
    <g className="connect-creature-accessory" data-accessory={accessory}>
      <g transform={`scale(${String(unit)})`}>
        {accessory === "glasses" ? (
          <>
            {eyes.map((x) => (
              <rect
                data-part="lens"
                key={x}
                x={x - frameWidth / 2}
                y={y - frameHeight / 2}
                width={frameWidth}
                height={frameHeight}
                rx="1.6"
                fill="white"
                fillOpacity="0.1"
                stroke={graphite}
                strokeWidth=".7"
              />
            ))}
            <path
              d={`M${String((eyes[0] ?? 0) + frameWidth / 2)} ${String(y - 0.5)}Q${String(centre)} ${String(y - 1.6)} ${String((eyes[1] ?? 0) - frameWidth / 2)} ${String(y - 0.5)}M${String((eyes[0] ?? 0) - frameWidth / 2)} ${String(y - 0.9)}L${String(side(y, -1) + 0.4)} ${String(y - 1.4)}M${String((eyes[1] ?? 0) + frameWidth / 2)} ${String(y - 0.9)}L${String(side(y, 1) - 0.4)} ${String(y - 1.4)}`}
              fill="none"
              stroke={graphite}
              strokeWidth=".7"
              strokeLinecap="round"
            />
            {eyes.map((x) => (
              <path
                key={x}
                d={`M${String(x - frameWidth / 2 + 0.9)} ${String(y - frameHeight / 2 + 1.6)}l1 -.9`}
                stroke="white"
                strokeOpacity=".7"
                strokeWidth=".35"
                strokeLinecap="round"
              />
            ))}
          </>
        ) : null}
        {accessory === "headphones" ? (
          <>
            <path
              data-part="headband"
              d={`M${String(lx + 1)} ${String(cy - 1.5)}C${String(lx + 1)} ${String(head - 6)} ${String(rx - 1)} ${String(head - 6)} ${String(rx - 1)} ${String(cy - 1.5)}`}
              fill="none"
              stroke={graphiteMid}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d={`M${String(lx + 1.6)} ${String(cy - 3.5)}C${String(lx + 1.6)} ${String(head - 4.6)} ${String(rx - 1.6)} ${String(head - 4.6)} ${String(rx - 1.6)} ${String(cy - 3.5)}`}
              fill="none"
              stroke={graphiteLight}
              strokeOpacity=".6"
              strokeWidth=".35"
              strokeLinecap="round"
            />
            {[lx, rx].map((x, index) => (
              <g key={x}>
                <rect
                  data-part="cup"
                  x={index === 0 ? x - 2.2 : x - 1}
                  y={cy - 3.1}
                  width="3.2"
                  height="6.2"
                  rx="1.4"
                  fill={graphite}
                />
                <rect
                  x={index === 0 ? x - 0.2 : x - 1}
                  y={cy - 2.3}
                  width="1.2"
                  height="4.6"
                  rx=".6"
                  fill={graphiteLight}
                />
              </g>
            ))}
          </>
        ) : null}
        {accessory === "hard-hat" ? (
          <>
            <path
              d={`M${String(centre - 7)} ${String(brim)}a7 7 0 0 1 14 0Z`}
              fill="#f2b30c"
              stroke="#7d5200"
              strokeWidth=".35"
            />
            <path
              d={`M${String(centre - 0.9)} ${String(brim - 6.9)}Q${String(centre)} ${String(brim - 7.1)} ${String(centre + 0.9)} ${String(brim - 6.9)}V${String(brim)}H${String(centre - 0.9)}Z`}
              fill="#ffd75e"
            />
            <rect
              data-part="brim"
              x={centre - 9.5}
              y={brim - 0.4}
              width="19"
              height="2"
              rx="1"
              fill="#c98700"
              stroke="#7d5200"
              strokeWidth=".35"
            />
            <path
              d={`M${String(centre - 5)} ${String(brim - 3.2)}q.8 -2.2 2.6 -2.9`}
              fill="none"
              stroke="white"
              strokeOpacity=".6"
              strokeWidth=".45"
              strokeLinecap="round"
            />
          </>
        ) : null}
        {accessory === "scarf" ? (
          <>
            <g clipPath={`url(#${skin})`} transform={`scale(${String(1 / unit)})`}>
              <rect
                x={(left - 1) * unit}
                y={scarfY * unit}
                width={(width + 2) * unit}
                height={2.6 * unit}
                fill="#efe5d3"
              />
              <rect
                x={(left - 1) * unit}
                y={(scarfY + 1.9) * unit}
                width={(width + 2) * unit}
                height={0.7 * unit}
                fill="#d4c5aa"
              />
            </g>
            <rect
              data-part="tail"
              x="-1.25"
              y="0"
              width="2.5"
              height="5.2"
              rx=".8"
              transform={`translate(${String(knot)} ${String(scarfY + 1.3)}) rotate(-14)`}
              fill="#efe5d3"
              stroke="#d4c5aa"
              strokeWidth=".4"
            />
            <rect
              x={knot - 1.7}
              y={scarfY - 0.3}
              width="3.4"
              height="3.2"
              rx="1.1"
              fill="#efe5d3"
              stroke="#d4c5aa"
              strokeWidth=".4"
            />
            <path
              d={`M${String(knot - 1.6)} ${String(scarfY + 5.6)}l.4 .9M${String(knot - 0.6)} ${String(scarfY + 5.8)}l.3 .9M${String(knot + 0.4)} ${String(scarfY + 5.5)}l.2 .9`}
              fill="none"
              stroke="#d4c5aa"
              strokeWidth=".4"
              strokeLinecap="round"
            />
          </>
        ) : null}
      </g>
    </g>
  )
}
