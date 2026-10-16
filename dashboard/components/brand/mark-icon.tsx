import { ImageResponse } from "next/og"

import { FG, INK, markDataUrl } from "./mark-image"

/**
 * A PNG of the mark on the dark ground, for places that show icons on their own background (search results draw
 * favicons on a white disc, where icon.svg's transparent background and dark-theme white lines may not show).
 */
export function markIcon(px: number) {
  const mark = Math.round(px * 0.8)
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: INK,
      }}
    >
      {/* oxlint-disable-next-line nextjs/no-img-element -- ImageResponse renders plain <img>; next/image can't run here */}
      <img src={markDataUrl(FG)} width={mark} height={mark} alt="" />
    </div>,
    { width: px, height: px },
  )
}
