import { sliceCoverage } from './questions.processor';

/**
 * Giving each batch of a request its own part of the topic.
 *
 * A request for fifty questions on one topic fans out to five jobs of ten.
 * Each job used to plan its own ten cells, and on a narrow topic five
 * independent plans are the same plan: the model works outward from the
 * fundamentals every time, so every batch covered the same first few ideas
 * and the request as a whole asked the same handful of things five times.
 *
 * The plan now covers the whole request and each batch takes a slice of it.
 */

const plan = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    subtopic: `sub${i}`,
    exercise: `ex${i}`,
  }));

describe('sliceCoverage', () => {
  it('gives different batches different parts of the plan', () => {
    const cells = plan(20);
    const first = sliceCoverage(cells, 0, 2, 10);
    const second = sliceCoverage(cells, 1, 2, 10);

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    // No cell is planned for two batches of the same request.
    const overlap = first.filter((a) =>
      second.some((b) => b.subtopic === a.subtopic),
    );
    expect(overlap).toEqual([]);
  });

  it('keeps each batch contiguous rather than interleaving them', () => {
    // A model enumerating a subject puts related ideas next to each other, so
    // a contiguous run lands a batch in one coherent region and the next
    // batch somewhere genuinely else. Interleaving would give every batch a
    // scattering of the same ground.
    expect(sliceCoverage(plan(20), 1, 2, 4).map((c) => c.subtopic)).toEqual([
      'sub10',
      'sub11',
      'sub12',
      'sub13',
    ]);
  });

  it('wraps when the topic has fewer cells than the request has questions', () => {
    // A narrow topic honestly runs out of cells. Repeating one with every
    // other check still in force beats dropping the plan.
    const out = sliceCoverage(plan(3), 0, 1, 7);
    expect(out).toHaveLength(7);
    expect(out.map((c) => c.subtopic)).toEqual([
      'sub0',
      'sub1',
      'sub2',
      'sub0',
      'sub1',
      'sub2',
      'sub0',
    ]);
  });

  it('handles a batch count that does not divide the plan evenly', () => {
    const cells = plan(10);
    for (let i = 0; i < 3; i++) {
      expect(sliceCoverage(cells, i, 3, 4)).toHaveLength(4);
    }
    // Four per batch over three batches, so the last one starts at cell 8.
    expect(sliceCoverage(cells, 2, 3, 2).map((c) => c.subtopic)).toEqual([
      'sub8',
      'sub9',
    ]);
  });

  it('survives a batch index past the end of the plan', () => {
    // An index out of range must still produce a usable slice rather than
    // undefined cells that would render as blank lines in the prompt.
    const out = sliceCoverage(plan(4), 9, 10, 3);
    expect(out).toHaveLength(3);
    out.forEach((cell) => expect(cell.subtopic).toMatch(/^sub\d$/));
  });

  it('asks for nothing when there is nothing to ask for', () => {
    expect(sliceCoverage([], 0, 1, 5)).toEqual([]);
    expect(sliceCoverage(plan(5), 0, 1, 0)).toEqual([]);
  });
});
