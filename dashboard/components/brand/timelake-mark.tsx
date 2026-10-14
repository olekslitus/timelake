import { type CSSProperties, useId } from "react"

import { cn } from "@/lib/utils"

import { MARK, WORDMARK } from "./mark-geometry"

/** The Timelake mark, drawn in the current text color. Geometry comes from brand/marks.mjs. */
export function TimelakeMark({
  className,
  title,
  size,
  style,
}: {
  className?: string
  title?: string
  size?: number
  style?: CSSProperties
}) {
  const clip = useId()
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clip}>
          <circle cx="50" cy="50" r={MARK.clipRadius} />
        </clipPath>
      </defs>
      <g
        clipPath={`url(#${clip})`}
        fill="none"
        stroke="currentColor"
        strokeWidth={MARK.strokeWidth}
        strokeLinejoin="miter"
        strokeMiterlimit={12}
        strokeLinecap="butt"
      >
        {MARK.lines.map((points) => (
          <polyline key={points} points={points} />
        ))}
      </g>
    </svg>
  )
}

/** Mark + "timelake" set to the brand proportions. `size` is the mark's height in pixels. */
export function TimelakeLockup({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)} style={{ gap: size * WORDMARK.gapOfMark }}>
      <TimelakeMark
        className="shrink-0"
        size={size}
        title="Timelake"
        style={{ transform: `translateY(${size * WORDMARK.markDropOfMark}px)` }}
      />
      <span
        aria-hidden
        className="font-sans leading-none"
        style={{
          fontSize: size * WORDMARK.sizeOfMark,
          fontWeight: WORDMARK.weight,
          letterSpacing: `${WORDMARK.letterSpacingEm}em`,
        }}
      >
        {WORDMARK.text}
      </span>
    </span>
  )
}
