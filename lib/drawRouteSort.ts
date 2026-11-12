/**
 * The order of the versions on the /draw results page (Ralph, Nov 9: "sort by
 * BEST or by DISTANCE, and show the top 5 that get delivered").
 *
 * "Best" is the engine's match score, highest first. Jobs from before Nov 9
 * carry no score; their delivered order was already best first ("Our pick",
 * then the shorter one), so that order stands in for the ranking.
 */

export type DrawSort = "best" | "distance";

export type RankedRoute<R> = {
  route: R;
  /** 0 = the best match, whatever order the page is showing */
  rank: number;
  /** position as delivered; stable, so it can key the card and its map */
  index: number;
};

type Sortable = { km: number; score?: number };

/** true when every route carries a match score (jobs since Nov 9) */
export function routesScored(routes: Sortable[]): boolean {
  return routes.length > 0 && routes.every((r) => typeof r.score === "number" && Number.isFinite(r.score));
}

/** best match first */
export function rankDrawRoutes<R extends Sortable>(routes: R[]): RankedRoute<R>[] {
  const order = routes.map((route, index) => ({ route, index }));
  if (routesScored(routes)) {
    order.sort((a, b) => (b.route.score ?? 0) - (a.route.score ?? 0) || a.index - b.index);
  }
  return order.map((o, rank) => ({ ...o, rank }));
}

/** a run most people can do in one go; the star goes to the best match at or under this */
export const RUNNABLE_KM = 25;

/**
 * The delivered index of the starred version: the best match of 25 km or
 * less, or the best match overall when every version is longer. The Nov 11
 * blind review: "the starred best match is never one I could run" (it was
 * always the 50 km one with the whole name). Null for unscored (older) jobs.
 */
export function pickIndex<R extends Sortable>(ranked: RankedRoute<R>[]): number | null {
  if (!routesScored(ranked.map((r) => r.route))) return null;
  const byRank = [...ranked].sort((a, b) => a.rank - b.rank);
  return (byRank.find((r) => r.route.km <= RUNNABLE_KM) ?? byRank[0]).index;
}

/**
 * The ranked routes in the order the page shows them; distance = shortest
 * first. `first` (the starred version's index) leads the best-match order.
 */
export function sortDrawRoutes<R extends Sortable>(
  ranked: RankedRoute<R>[],
  mode: DrawSort,
  first: number | null = null,
): RankedRoute<R>[] {
  if (mode === "best") {
    return [...ranked].sort((a, b) => Number(b.index === first) - Number(a.index === first) || a.rank - b.rank);
  }
  return [...ranked].sort((a, b) => a.route.km - b.route.km || a.rank - b.rank);
}
