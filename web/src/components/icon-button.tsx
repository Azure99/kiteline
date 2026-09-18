import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { ComponentProps } from "react";

export function IconButton({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon" variant="ghost" aria-label={label} {...props} />}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
