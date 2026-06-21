// Skeleton — content-shaped loading placeholders. A `Skeleton` is a single
// rounded block sized by the caller; callers compose them into content-shaped
// layouts (a row, a card) that mimic the real UI's structure while data loads.
//
// The wrapping `SkeletonGroup` carries the loading semantics for assistive tech
// (role="status" / aria-busy), so the individual blocks are aria-hidden. The
// shimmer is gated in CSS behind both the OS reduced-motion preference and the
// app's data-reduce-motion attribute; under reduced motion the blocks render
// static rather than vanishing.

import type { CSSProperties, ReactNode } from "react";

export function Skeleton({
  width,
  height,
  radius,
  className,
}: {
  width: string;
  height: string;
  radius?: string;
  className?: string;
}): JSX.Element {
  const style: CSSProperties = { width, height };
  if (radius !== undefined) style.borderRadius = radius;
  return (
    <span
      aria-hidden="true"
      className={className ? `skeleton ${className}` : "skeleton"}
      style={style}
    />
  );
}

export function SkeletonGroup({
  children,
  label,
  testId,
  className,
}: {
  children: ReactNode;
  label: string;
  testId: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-testid={testId}
      className={className ? `skeleton-group ${className}` : "skeleton-group"}
    >
      {children}
    </div>
  );
}
