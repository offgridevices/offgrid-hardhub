// The floating controls over a drawing: zoom out, fit, zoom in.
import type { ReactNode } from "react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ZoomControls({ onIn, onOut, onFit, className }: { onIn(): void; onOut(): void; onFit(): void; className?: string }) {
  return (
    <div data-nopan className={cn("flex items-center gap-0.5 rounded-lg border bg-card/95 p-0.5 shadow-lg shadow-black/20 backdrop-blur", className)}>
      <Button variant="ghost" size="icon-sm" onClick={onOut} aria-label="Zoom out">
        <MinusIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onFit} aria-label="Fit to view">
        <MaximizeIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onIn} aria-label="Zoom in">
        <PlusIcon />
      </Button>
    </div>
  );
}

/** A bar of controls across the top of a full-bleed view. */
export function ViewBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2", className)}>{children}</div>;
}

/** A thin divider between groups in a ViewBar. */
export function BarRule() {
  return <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />;
}
