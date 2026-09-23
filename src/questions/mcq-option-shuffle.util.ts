/**
 * LLMs have a well-known positional bias when generating MCQs: across a batch,
 * the "correct" option clusters on the same option number (e.g. mostly "2")
 * regardless of prompt instructions telling them to vary it. Prompting alone
 * cannot reliably fix this, so we re-shuffle each question's option order in
 * code after generation, guaranteeing the correct answer's position is
 * uniformly randomized independent of what the model produced.
 */
export function shuffleMcqOptionOrder(
  options: Record<string, string>,
  correctOption: number,
): { options: Record<string, string>; correctOption: number } {
  const positions = ['1', '2', '3', '4'];
  if (positions.some((p) => typeof options[p] !== 'string')) {
    return { options, correctOption };
  }

  const shuffledSourcePositions = [...positions];
  for (let i = shuffledSourcePositions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledSourcePositions[i], shuffledSourcePositions[j]] = [
      shuffledSourcePositions[j],
      shuffledSourcePositions[i],
    ];
  }

  const correctSourcePosition = String(correctOption);
  const newOptions: Record<string, string> = {};
  let newCorrectOption = correctOption;

  positions.forEach((newPosition, idx) => {
    const sourcePosition = shuffledSourcePositions[idx];
    newOptions[newPosition] = options[sourcePosition];
    if (sourcePosition === correctSourcePosition) {
      newCorrectOption = Number(newPosition);
    }
  });

  return { options: newOptions, correctOption: newCorrectOption };
}
