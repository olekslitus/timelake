import { MARK } from "./mark-geometry"

// Colors of the dark brand ground, shared by the share card and the PNG icons.
export const INK = "#0B0D0E"
export const FG = "#E6EBED"

/** The mark as an SVG data URL for next/og images: Satori ignores clip paths on inline SVG, resvg renders an image. */
export function markDataUrl(stroke: string) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="c"><circle cx="50" cy="50" r="${MARK.clipRadius}"/></clipPath></defs>` +
    `<g clip-path="url(#c)" fill="none" stroke="${stroke}" stroke-width="${MARK.strokeWidth}" stroke-linejoin="miter" stroke-miterlimit="12">` +
    MARK.lines.map((p) => `<polyline points="${p}"/>`).join("") +
    `</g></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}
