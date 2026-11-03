// Board layers by the names people use for them ("Top copper", not "F.Cu"),
// shared by the layout, the 3D view and the tests.
const NAMES: Record<string, string> = {
  "F.Cu": "Top copper",
  "B.Cu": "Bottom copper",
  "F.Silkscreen": "Top print",
  "B.Silkscreen": "Bottom print",
  "F.Mask": "Top solder mask",
  "B.Mask": "Bottom solder mask",
  "F.Paste": "Top paste",
  "B.Paste": "Bottom paste",
  "Edge.Cuts": "Outline",
  "F.Fab": "Top part outlines",
  "B.Fab": "Bottom part outlines",
};
export const layerName = (l: string) => NAMES[l] ?? l.replace(/^In(\d+)\.Cu$/, "Inner $1");
