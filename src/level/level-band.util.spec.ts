import { bandsWithFloors, resolveLevelBand } from './level-band.util';

/**
 * The fixture is the shipped seed, verbatim, including the two bands that carry
 * a scoreMax and no scoreMin. Those omissions are what the old lookup tripped
 * over, so a tidied-up fixture would test nothing.
 */
const SEEDED = [
  { grade: 'A+', scoreMin: 90 },
  { grade: 'A', scoreMin: 80, scoreMax: 89 },
  { grade: 'B', scoreMin: 70, scoreMax: 79 },
  { grade: 'C', scoreMin: 60, scoreMax: 69 },
  { grade: 'D', scoreMax: 59 },
  { grade: 'E', scoreMax: 39 },
];

const gradeFor = (score: number) => resolveLevelBand(SEEDED, score)?.grade;

describe('resolveLevelBand', () => {
  it('assigns E, which the previous lookup could never reach', () => {
    // D carried no scoreMin, so it matched everything at or below 59 and
    // answered before E was considered.
    expect(gradeFor(5)).toBe('E');
    expect(gradeFor(25)).toBe('E');
    expect(gradeFor(39)).toBe('E');
  });

  it('places a score between two published bands in the lower one', () => {
    // 17 correct out of 19 is 89.47, which belonged to no band and used to
    // fall through to E - a near-A+ result recorded as "requires
    // intervention".
    expect(gradeFor(89.47)).toBe('A');
    expect(gradeFor(79.5)).toBe('B');
    expect(gradeFor(69.2)).toBe('C');
    expect(gradeFor(59.8)).toBe('D');
    expect(gradeFor(39.9)).toBe('E');
  });

  it('keeps the bands the seed already got right', () => {
    expect(gradeFor(95)).toBe('A+');
    expect(gradeFor(90)).toBe('A+');
    expect(gradeFor(85)).toBe('A');
    expect(gradeFor(75)).toBe('B');
    expect(gradeFor(65)).toBe('C');
    expect(gradeFor(45)).toBe('D');
  });

  it('puts every boundary on the band that claims it', () => {
    expect(gradeFor(89)).toBe('A');
    expect(gradeFor(80)).toBe('A');
    expect(gradeFor(79)).toBe('B');
    expect(gradeFor(70)).toBe('B');
    expect(gradeFor(60)).toBe('C');
    expect(gradeFor(59)).toBe('D');
    expect(gradeFor(40)).toBe('D');
  });

  it('does not depend on the order rows come back in', () => {
    // The old lookup read whatever SELECT * returned, so its answer changed
    // with the row order.
    const shuffled = [...SEEDED].reverse();
    [5, 45, 65, 89.47, 95].forEach((score) => {
      expect(resolveLevelBand(shuffled, score)?.grade).toBe(gradeFor(score));
    });
  });

  it('derives the floor each band behaves as', () => {
    const floors = Object.fromEntries(
      bandsWithFloors(SEEDED).map(({ band, floor }) => [band.grade, floor]),
    );
    expect(floors).toEqual({ E: 0, D: 40, C: 60, B: 70, A: 80, 'A+': 90 });
  });

  it('follows the data rather than hard-coded cut-offs', () => {
    const custom = [
      { grade: 'PASS', scoreMin: 50 },
      { grade: 'FAIL', scoreMax: 49 },
    ];
    expect(resolveLevelBand(custom, 50)?.grade).toBe('PASS');
    expect(resolveLevelBand(custom, 49.9)?.grade).toBe('FAIL');
  });

  it('handles a score below every band, and no bands at all', () => {
    expect(gradeFor(-1)).toBe('E');
    expect(resolveLevelBand([], 50)).toBeNull();
  });

  it('assigns a grade to every whole percentage from 0 to 100', () => {
    // The real guarantee: no score can land nowhere.
    for (let score = 0; score <= 100; score++) {
      expect(gradeFor(score)).toBeDefined();
    }
  });
});
