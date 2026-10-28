// The OffGrid ring, drawn from its geometry (OffGrid brand v3.2.2): an open
// ring of radius 58 and stroke 22 with round caps, and a node of radius 17 at
// the top, in a 200-unit box. The ring's centre is at (100, 108).
import { memo } from "react";
import { onLink } from "../lib/router";

export const Mark = memo(function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 200 200" aria-hidden="true">
      <path d="M124.5 55.4A58 58 0 1 1 75.5 55.4" fill="none" stroke="var(--accent)" strokeWidth="22" strokeLinecap="round" />
      <circle cx="100" cy="40" r="17" fill="var(--accent)" />
    </svg>
  );
});

/** "HardHub by OffGrid", inline lockup placed from the text baseline. */
export const Lockup = memo(function Lockup({ href = "/", by = true }: { href?: string; by?: boolean }) {
  return (
    <a className="lockup" href={href} onClick={onLink} aria-label="HardHub by OffGrid, home">
      <Mark className="mark" />
      <span>HardHub</span>
      {by && <span className="by">by OffGrid</span>}
    </a>
  );
});
