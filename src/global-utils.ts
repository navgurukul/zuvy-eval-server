// create a global utility file if needed in future

// -----------------------------------------
// cteate a method to randomize tha Assessment questions
export function randomizeAssessmentQuestions(questions: any[]): any[] {
  if (!Array.isArray(questions) || questions.length === 0) return questions;

    const shuffled = [...questions]; // clone array (no mutation)

    // Fisher–Yates shuffle → best for production use
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
}


