// Line icons in the OffGrid language: 1.5 px strokes, square ends and
// corners, drawn on a 20 px grid, coloured by the text around them.
import type { ReactNode, SVGProps } from "react";

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** what the board must do: a checked list */
export const IconRequirements = () => (
  <Svg>
    <path d="M3 5.5l1.5 1.5 2.5-3M3 13.5l1.5 1.5 2.5-3M10 5.5h7M10 13.5h7" />
  </Svg>
);

/** the parts: a chip with its pins */
export const IconParts = () => (
  <Svg>
    <rect x="5.5" y="5.5" width="9" height="9" />
    <path d="M8 2.5v3M12 2.5v3M8 14.5v3M12 14.5v3M2.5 8h3M2.5 12h3M14.5 8h3M14.5 12h3" />
  </Svg>
);

/** the circuit: a resistor between two nodes */
export const IconCircuit = () => (
  <Svg>
    <path d="M2.5 10h3l1.5-3 2 6 2-6 2 6 1.5-3h3" />
  </Svg>
);

/** the layout: a board with a routed track and a via */
export const IconLayout = () => (
  <Svg>
    <rect x="2.5" y="3.5" width="15" height="13" />
    <path d="M5.5 13.5h4l3-4h2" />
    <rect x="14.5" y="8.5" width="1" height="1" />
  </Svg>
);

/** the 3D view: a cube */
export const Icon3D = () => (
  <Svg>
    <path d="M10 2.5l6.5 3.5v8L10 17.5 3.5 14V6L10 2.5zM3.5 6L10 9.5 16.5 6M10 9.5v8" />
  </Svg>
);

/** the checks: a tick in a square */
export const IconChecks = () => (
  <Svg>
    <rect x="3" y="3" width="14" height="14" />
    <path d="M6.5 10l2.5 2.5 4.5-5" />
  </Svg>
);

/** the order: a parcel */
export const IconOrder = () => (
  <Svg>
    <path d="M3 6.5L10 3l7 3.5v7L10 17l-7-3.5v-7zM3 6.5l7 3.5 7-3.5M10 10v7M6.5 4.8l7 3.5" />
  </Svg>
);

export const IconTrash = () => (
  <Svg>
    <path d="M3.5 5.5h13M8 5.5V3h4v2.5M5.5 5.5l.8 11.5h7.4l.8-11.5M8.5 8.5v5.5M11.5 8.5v5.5" />
  </Svg>
);
