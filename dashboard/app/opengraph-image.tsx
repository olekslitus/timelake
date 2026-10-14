import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { ImageResponse } from "next/og"

import { MARK } from "@/components/brand/mark-geometry"

// The card shown when a timelake.dev link is shared. Geist fonts are in assets/fonts (SIL Open Font License).
export const alt = "Timelake: the open time-series lakehouse"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const fonts = join(process.cwd(), "assets/fonts")
const [light, medium, mono] = await Promise.all([
  readFile(join(fonts, "Geist-Light.ttf")),
  readFile(join(fonts, "Geist-Medium.ttf")),
  readFile(join(fonts, "GeistMono-Medium.ttf")),
])

const INK = "#0B0D0E",
  LINE = "#23292C",
  FG = "#E6EBED",
  MUTED = "#8B969B",
  ICE = "#67D4F0"

// Satori ignores clip paths on inline SVG, so the mark goes in as an SVG image (rendered with resvg).
const markSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="c"><circle cx="50" cy="50" r="${MARK.clipRadius}"/></clipPath></defs>` +
  `<g clip-path="url(#c)" fill="none" stroke="${FG}" stroke-width="${MARK.strokeWidth}" stroke-linejoin="miter" stroke-miterlimit="12">` +
  MARK.lines.map((p) => `<polyline points="${p}"/>`).join("") +
  `</g></svg>`
const markSrc = `data:image/svg+xml;base64,${Buffer.from(markSvg).toString("base64")}`

export default function Image() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", background: INK, padding: 40 }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          border: `1px solid ${LINE}`,
          borderRadius: 8,
          padding: "56px 64px",
          background: "#101315",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <img src={markSrc} width={72} height={72} alt="" />
          <div style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 45, letterSpacing: "-0.045em", color: FG }}>
            timelake
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              fontFamily: "Geist",
              fontWeight: 300,
              fontSize: 78,
              lineHeight: 1.04,
              letterSpacing: "-0.03em",
              color: FG,
            }}
          >
            The open time-series lakehouse
          </div>
          <div style={{ fontFamily: "Geist", fontWeight: 300, fontSize: 30, color: MUTED }}>
            Fast queries on your own object storage, with no database and no maintenance jobs.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "Geist Mono",
            fontSize: 20,
            letterSpacing: "0.1em",
          }}
        >
          <span style={{ color: MUTED }}>OPEN SOURCE · APACHE 2.0</span>
          <span style={{ color: ICE }}>TIMELAKE.DEV</span>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Geist", data: light, weight: 300, style: "normal" },
        { name: "Geist", data: medium, weight: 500, style: "normal" },
        { name: "Geist Mono", data: mono, weight: 500, style: "normal" },
      ],
    },
  )
}
