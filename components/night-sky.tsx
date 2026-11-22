/**
 * Decorative night sky: stars, a crescent moon and a few linked network
 * nodes. Pure SVG with Tailwind classes only (no inline style attributes,
 * which the CSP would block). Hidden from screen readers.
 */

// Fixed positions so server and client render the same thing.
const STARS: ReadonlyArray<readonly [number, number, number, 0 | 1 | 2]> = [
  [40, 30, 1.2, 1], [120, 80, 0.8, 0], [210, 24, 1.4, 2], [300, 110, 0.9, 0], [380, 40, 1.1, 1],
  [470, 90, 0.7, 0], [540, 20, 1.3, 2], [620, 120, 0.8, 0], [700, 60, 1.2, 1], [780, 30, 0.9, 0],
  [860, 100, 1.4, 2], [940, 50, 0.8, 0], [1020, 130, 1.1, 1], [1100, 36, 0.7, 0], [1160, 92, 1.2, 2],
  [70, 150, 0.7, 0], [250, 170, 1, 1], [430, 160, 0.8, 0], [660, 180, 1, 2], [900, 170, 0.7, 0], [1080, 190, 1, 1],
];

const NODES: ReadonlyArray<readonly [number, number]> = [
  [700, 230], [770, 185], [850, 240], [920, 195], [800, 295], [950, 270],
];
const LINKS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [1, 4], [2, 4], [3, 5], [2, 5],
];

export function NightSky({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1200 320"
      preserveAspectRatio="xMidYMid slice"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    >
      {STARS.map(([x, y, r, t], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={r}
          className={`fill-lavender ${t === 1 ? "twinkle" : t === 2 ? "twinkle-slow" : "opacity-60"}`}
        />
      ))}
      {/* Network motif: PCs (nodes) linked into one pool. */}
      <g className="opacity-70">
        {LINKS.map(([a, b], i) => (
          <line
            key={i}
            x1={NODES[a]![0]}
            y1={NODES[a]![1]}
            x2={NODES[b]![0]}
            y2={NODES[b]![1]}
            className="stroke-navy"
            strokeWidth="1.5"
          />
        ))}
        {NODES.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i === 2 ? 6 : 4} className={i === 2 ? "fill-orange" : "fill-mist"} />
        ))}
      </g>
    </svg>
  );
}

/** Crescent moon pinned to the top-right corner of its container, at every width. */
export function Moon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 80 80" className="pointer-events-none absolute top-8 right-4 h-14 w-14 sm:top-12 sm:right-12 sm:h-24 sm:w-24">
      <circle cx="40" cy="40" r="30" className="fill-lavender opacity-90" />
      <circle cx="54" cy="30" r="27" className="fill-deep" />
    </svg>
  );
}

export function MoonMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 32 32" className={className}>
      <circle cx="16" cy="16" r="12" className="fill-orange" />
      <circle cx="21" cy="12" r="10" className="fill-night" />
      <circle cx="25" cy="24" r="1.6" className="fill-lavender" />
      <circle cx="28" cy="18" r="1" className="fill-lavender" />
    </svg>
  );
}
