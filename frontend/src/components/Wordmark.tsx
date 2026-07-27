import { cn } from "../lib/cn";

/**
 * The one place Bricolage Grotesque gets to show off. Everywhere else the
 * chrome stays quiet.
 */
export function Wordmark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "text-lg", md: "text-3xl", lg: "text-4xl" } as const;
  return (
    <span
      className={cn(
        "inline-block select-none font-display font-extrabold uppercase leading-none tracking-[-0.03em]",
        sizes[size],
      )}
    >
      Optata
    </span>
  );
}
