export function ApplicationTitle({ title }: { title?: string }) {
  return title ? (
    <span title={title} className="min-w-0 truncate text-xs text-muted-foreground">
      {title}
    </span>
  ) : null;
}
