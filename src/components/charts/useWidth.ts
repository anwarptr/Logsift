import { useEffect, useRef, useState } from 'react';

/** Width of the referenced element, kept up to date with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(initial = 600, min = 200) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(min, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, width] as const;
}

/** Current value of a CSS custom property on the document (charts drawn on canvas need real colours). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
