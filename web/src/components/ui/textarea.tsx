import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-9 w-full min-w-0 rounded border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-[959px]:min-h-11 max-[959px]:text-base",
        className,
      )}
      {...props}
    />
  );
}
