import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// A deterministic, single-paint sky. This is generated at design time rather
// than building hundreds of DOM nodes or repainting a canvas in every Room.
const output = fileURLToPath(
  new URL("../public/cosmic-stars.svg", import.meta.url)
)
const width = 1600
const height = 1100
let seed = 60923
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const between = (min, max) => min + random() * (max - min)
const fixed = (value) => value.toFixed(1).replace(/\.0$/, "")
const colors = ["#eaf4ff", "#d8e9ff", "#a9d9ff", "#a4c4ff", "#ffcba8"]
const chooseColor = () => {
  const value = random()
  return colors[
    value < 0.47
      ? 0
      : value < 0.68
      ? 1
      : value < 0.82
      ? 2
      : value < 0.93
      ? 3
      : 4
  ]
}

const stars = []
for (let index = 0; index < 1250; index += 1) {
  const x = between(0, width)
  const y = between(0, height)
  const bright = random() > 0.92
  const radius = bright ? between(1.05, 1.95) : between(0.45, 1.15)
  const opacity = bright ? between(0.68, 0.98) : between(0.32, 0.84)
  stars.push(
    `<circle cx="${fixed(x)}" cy="${fixed(y)}" r="${fixed(
      radius
    )}" fill="${chooseColor()}" opacity="${opacity.toFixed(2)}"/>`
  )
}

// A loose diagonal star cloud makes the sky feel deep without a tiled pattern.
for (let index = 0; index < 450; index += 1) {
  const x = between(0, width)
  const center = 570 - 0.17 * (x - width / 2)
  const y = center + (random() + random() + random() - 1.5) * 390
  if (y < 0 || y > height) continue
  stars.push(
    `<circle cx="${fixed(x)}" cy="${fixed(y)}" r="${fixed(
      between(0.3, 0.85)
    )}" fill="${chooseColor()}" opacity="${between(0.16, 0.48).toFixed(2)}"/>`
  )
}

const beacons = [
  [146, 312, 1],
  [384, 153, 0.7],
  [672, 389, 0.9],
  [918, 177, 0.72],
  [1312, 290, 1.15],
  [1491, 593, 0.75],
  [272, 834, 0.8],
  [729, 887, 0.7],
  [1066, 712, 0.9],
  [1430, 967, 0.72],
]
const flares = beacons.map(([x, y, scale]) => {
  const arm = fixed(17 * scale)
  const inner = fixed(4 * scale)
  return `<g transform="translate(${x} ${y})" opacity=".83"><circle r="${fixed(
    11 * scale
  )}" fill="url(#star-glow)"/><path d="M0 -${arm}V${arm}M-${arm} 0H${arm}" stroke="#dff6ff" stroke-width=".7"/><path d="M0 -${inner}V${inner}M-${inner} 0H${inner}" stroke="#fff" stroke-width="1.3"/><circle r="1.8" fill="#fff"/></g>`
})

const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="none">
<defs><radialGradient id="star-glow"><stop stop-color="#cceeff" stop-opacity=".6"/><stop offset="1" stop-color="#cceeff" stop-opacity="0"/></radialGradient></defs>
${stars.join("\n")}
${flares.join("\n")}
</svg>
`
writeFileSync(output, markup)
console.log(
  `Generated ${stars.length} stars and ${flares.length} beacons in ${output}`
)
