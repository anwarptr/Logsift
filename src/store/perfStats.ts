/** How long the last columnar index build took; live tail checks less often for big logs. */
let indexBuildMs = 0;

export const setIndexBuildMs = (ms: number): void => {
  indexBuildMs = ms;
};

export const getIndexBuildMs = (): number => indexBuildMs;

/** Delay between live checks: at least 1 s, and 4× the index build time (each update rebuilds it). */
export const liveCheckDelayMs = (): number => Math.min(30_000, Math.max(1000, Math.round(4 * indexBuildMs)));
