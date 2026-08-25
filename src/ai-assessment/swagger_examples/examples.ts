export const submitAssessmentExample = {
  answers: [
    {
      id: 1,
      question:
        'What will be the output of the following code?\n\n```javascript\nconsole.log(typeof null);\n```',
      topic: 'JavaScript Basics',
      difficulty: 'Easy',
      options: {
        '1': '"object"',
        '2': '"null"',
        '3': '"undefined"',
        '4': '"number"',
      },
      correctOption: 1,
      selectedAnswerByStudent: 1,
      language: 'JavaScript',
    },
    {
      id: 2,
      question: 'What is the result of `2 + "2"` in JavaScript?',
      topic: 'Type Coercion',
      difficulty: 'Easy',
      options: {
        '1': '"4"',
        '2': '"22"',
        '3': 'NaN',
        '4': 'undefined',
      },
      correctOption: 2,
      selectedAnswerByStudent: 2,
      language: 'JavaScript',
    },
    {
      id: 3,
      question: 'Which keyword is used to declare a constant in JavaScript?',
      topic: 'Variables',
      difficulty: 'Easy',
      options: {
        '1': 'var',
        '2': 'let',
        '3': 'const',
        '4': 'static',
      },
      correctOption: 3,
      selectedAnswerByStudent: 3,
      language: 'JavaScript',
    },
  ],
};

export const scoreSubmitExample = {
  assessmentId: 137,
  courseId: 1040,
  moduleId: 896,
  chapterId: 6688,
  questions: [
    {
      questionId: 750,
      position: 1,
      question: 'If a point is equidistant from both axes and lies in Quadrant IV, what are its possible coordinates?',
      options: { '1': '(a, a), a > 0', '2': '(-a, -a), a > 0', '3': '(a, -a), a > 0', '4': '(-a, a), a > 0' },
      difficulty: 'hard',
      topic: 'Quadrants',
      language: 'English',
      correctOptionSelectedByStudents: 3,
    },
    {
      questionId: 751,
      position: 2,
      question: 'If the product of the coordinates of a point (x, y) is negative, in which quadrants can it lie?',
      options: { '1': 'Only Quadrant I', '2': 'Only Quadrants II and III', '3': 'Only Quadrants I and III', '4': 'Only Quadrants II and IV' },
      difficulty: 'hard',
      topic: 'Quadrants',
      language: 'English',
      correctOptionSelectedByStudents: 4,
    },
  ],
};

export const mapQuestionsExample = {
  aiAssessmentId: 800,
};

export const scheduleAssessmentExample = {
  startDatetime: '2026-04-10T09:00:00+05:30',
  endDatetime: '2026-04-10T11:00:00+05:30',
};

export const scheduleAssessmentNoEndExample = {
  startDatetime: '2026-04-10T09:00:00+05:30',
};

export const publishAssessmentExample = {
  endDatetime: '2026-04-10T11:00:00+05:30',
};

export const publishAssessmentNoEndExample = {};

export const createAiAssessmentBootcamp = {
  bootcampId: 803,
  chapterId: 12,
  title: 'JavaScript Fundamentals Assessment',
  objective: 'Evaluate understanding of core JavaScript concepts and syntax',
  description: 'Covers core JS concepts including closures, async, and DOM',
  audience: 'Beginners with basic programming knowledge',
  expectedOutcomes: 'Identify areas of strength and improvement in JavaScript fundamentals',
  totalNumberOfQuestions: 10,
  chapterIds: [12, 13, 14],
  moduleId: 806,
  poolTopics: [{ id: 1, name: 'JavaScript Basics' }],
};

