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

export const mapQuestionsExample = {
  aiAssessmentId: 800,
};

export const createAiAssessmentBootcamp = {
  bootcampId: 803,
  title: 'JavaScript Fundamentals Assessment',
  description: 'Covers core JS concepts including closures, async, and DOM',
  audience: 'Beginners with basic programming knowledge',
  totalNumberOfQuestions: 10,
  startDatetime: '2026-04-10T09:00:00+05:30',
  endDatetime: '2026-04-10T11:00:00+05:30',
};

export const createAiAssessmentDomain = {
  bootcampId: 803,
  scope: 'domain',
  domainId: 5,
  title: 'Data Structures Assessment',
  description: 'Covers trees, linked lists, and graph traversal algorithms',
  audience: 'Students who completed the DSA module',
  totalNumberOfQuestions: 15,
  startDatetime: '2026-04-15T14:00:00+05:30',
  endDatetime: '2026-04-15T16:30:00+05:30',
};
