import { markIcon } from "@/components/brand/mark-icon"

// Search engines want a square favicon whose side is a multiple of 48 px.
export const size = { width: 96, height: 96 }
export const contentType = "image/png"

export default function Icon() {
  return markIcon(size.width)
}
