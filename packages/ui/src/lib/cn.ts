import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names.
 *
 * `clsx` resolves conditionals; `twMerge` then resolves Tailwind conflicts so a
 * caller's override (`className="px-6"`) actually beats a component's default
 * (`px-4`) instead of both classes landing in the DOM and specificity
 * deciding. Without `twMerge` the shadcn convention silently stops working the
 * moment a component takes a `className`.
 *
 * **Consequence, which matters for the accessibility tests:** a caller cannot
 * accidentally remove the focus ring by passing `className`. If they did try,
 * `twMerge` would keep the later `focus-visible:ring-*` utility — and
 * `focus-ring.test.tsx` asserts that the ring survives a `className` override.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}