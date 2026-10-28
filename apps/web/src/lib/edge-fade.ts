// A row that scrolls sideways (the stage bar, the tabs) fades out on the side
// that has more, so a phone shows there is more to swipe to. Sets
// data-fade="l" | "r" | "lr" on the element; the CSS draws the fade.
import { useEffect, type RefObject } from "react";

export function useEdgeFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const l = el.scrollLeft > 2;
      const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      const v = (l ? "l" : "") + (r ? "r" : "");
      if (v) el.dataset.fade = v;
      else delete el.dataset.fade;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref]);
}

/** Scroll a row so `child` sits in the middle, when the row overflows. */
export function centreIn(row: HTMLElement | null, child: HTMLElement | null) {
  if (!row || !child || row.scrollWidth <= row.clientWidth) return;
  row.scrollLeft = child.offsetLeft - (row.clientWidth - child.offsetWidth) / 2;
}
