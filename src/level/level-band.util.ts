/**
 * Turning a percentage into a grade band.
 *
 * The seeded bands do not tile the number line, and the old lookup walked them
 * in whatever order Postgres returned rows. Two things went wrong because of
 * that, and the second is the worse one:
 *
 *   - D carries a scoreMax of 59 and no scoreMin, so it matched every score at
 *     or below 59. Sitting ahead of E in insertion order, it answered first and
 *     E was never assigned at all.
 *
 *   - The bands stop at whole numbers - A is 80 to 89, A+ starts at 90 - while
 *     the score is a percentage rounded to two decimals. 17 right out of 19 is
 *     89.47, which is inside no band, so the lookup found nothing and fell back
 *     to E. A student a whisker off A+ was recorded as "requires intervention".
 *
 * Both are fixed by treating the bands as a ladder rather than a list of
 * independent ranges. Each band's real floor is one above the top of the band
 * below it, so the ladder is continuous by construction and a score between two
 * published bounds belongs to the lower of the two.
 *
 * The ladder is derived from the data rather than hard-coded, so an
 * organisation that reseeds with different cut-offs keeps working, and a
 * database seeded before this was written needs no migration.
 */

export type LevelBand = {
  grade?: string | null;
  scoreMin?: number | null;
  scoreMax?: number | null;
};

/**
 * The bands, lowest first, each with the floor it actually behaves as.
 *
 * An explicit scoreMin is honoured when the seed gives one. Where it does not -
 * D and E in the shipped seed - the floor is taken from the band below, which
 * is what the published ranges ("< 60", "< 40") were describing anyway.
 */
export function bandsWithFloors<T extends LevelBand>(
  levels: readonly T[],
): Array<{ band: T; floor: number }> {
  const ordered = [...levels].sort(
    (a, b) => (a.scoreMax ?? Infinity) - (b.scoreMax ?? Infinity),
  );

  let previousCeiling: number | null = null;
  return ordered.map((band) => {
    const floor =
      band.scoreMin ?? (previousCeiling === null ? 0 : previousCeiling + 1);
    previousCeiling = band.scoreMax ?? Infinity;
    return { band, floor };
  });
}

/**
 * The band a score falls in, or null when there are no bands at all.
 *
 * Walks from the top down and takes the first band the score reaches, so every
 * score lands somewhere and no gap can send a near-perfect result to the bottom
 * of the scale.
 */
export function resolveLevelBand<T extends LevelBand>(
  levels: readonly T[],
  score: number,
): T | null {
  if (!levels.length) return null;

  const ladder = bandsWithFloors(levels);
  for (let i = ladder.length - 1; i >= 0; i--) {
    if (score >= ladder[i].floor) return ladder[i].band;
  }

  // Below every floor, which only happens with a negative score. The lowest
  // band is the honest answer rather than nothing.
  return ladder[0].band;
}
