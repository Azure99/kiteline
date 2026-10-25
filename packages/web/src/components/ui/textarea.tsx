import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-9 w-full min-w-0 rounded border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-desk:min-h-11 max-desk:text-base",
        className,
      )}
      {...props}
    />
  );
}
