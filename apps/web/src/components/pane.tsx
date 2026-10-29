// The frame of a view in the workspace: a title, a line of explanation, and
// sections, each a heading over its content.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Pane({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8", className)}>{children}</div>;
}

export function PaneHead({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 max-w-[68ch] flex-col gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {children && <div className="text-soft">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside && <div className="text-xs text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Nothing to show yet: what will appear here, and when. */
export function Empty({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-2 px-6 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
