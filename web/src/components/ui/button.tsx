import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded border text-sm font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45 disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-white hover:brightness-95",
        outline: "border-border bg-background hover:bg-muted",
        ghost: "border-transparent hover:bg-muted",
        destructive: "border-destructive bg-destructive text-white hover:brightness-95",
      },
      size: {
        default: "min-h-8 px-3 py-1.5 max-desk:min-h-11",
        icon: "size-8 max-desk:size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
