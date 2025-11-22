import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CreateCorrectAnswerDto,
  CreateMcqQuestionOptionDto,
  CreateQuestionsByLlmDto,
} from './dto/create-questions-by-llm.dto';
import { UpdateQuestionsByLlmDto } from './dto/update-questions-by-llm.dto';
import { questionsByLLM } from 'src/db/schema/questionByLLm';
import { mcqQuestionOptions } from 'src/db/schema/mcqQuestionOpt';
import { questionLevelRelation } from 'src/db/schema/questionLevel';
import { correctAnswers } from 'src/db/schema/correctAns';
import { asc, inArray, and } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomizeAssessmentQuestions } from 'src/global-utils';
import { studentAssessment } from 'src/db/schema/stdAssessment';
import { studentLevelRelation } from 'src/db/schema/studentLevel';

@Injectable()
export class QuestionsByLlmService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase
  ) { }
  private readonly logger = new Logger(QuestionsByLlmService.name);
  async createMcqQuestionOption(dto: CreateMcqQuestionOptionDto) {
    return await this.db.insert(mcqQuestionOptions).values(dto).returning();
  }

  async createCorrectAnswer(dto: CreateCorrectAnswerDto) {
    return await this.db.insert(correctAnswers).values(dto).returning();
  }

  async create(
    createQuestionsByLlmDto: CreateQuestionsByLlmDto,
    aiAssessmentId,
  ) {
    const { questions, levelId } = createQuestionsByLlmDto;

    const questionsPayload = questions.map((q) => ({
      topic: q.topic ?? null,
      difficulty: q.difficulty ?? null,
      question: q.question,
      language: q.language,
      aiAssessmentId,
    }));

    try {
      const result = await this.db.transaction(async (tx) => {
        let insertedQuestions;

        // 1️⃣ Insert questions
        try {
          insertedQuestions = await tx
            .insert(questionsByLLM)
            .values(questionsPayload)
            .returning({
              id: questionsByLLM.id,
              question: questionsByLLM.question,
              topic: questionsByLLM.topic,
              difficulty: questionsByLLM.difficulty,
              language: questionsByLLM.language,
            });
        } catch (err) {
          this.logger.error('Error inserting questionsByLLM:', err);
          throw new InternalServerErrorException('Failed to insert questions');
        }

        // 2️⃣ Insert question-level relations
        if (levelId) {
          try {
            const relationsPayload = insertedQuestions.map((q) => ({
              questionId: q.id,
              levelId: Number(levelId),
            }));
            await tx.insert(questionLevelRelation).values(relationsPayload);
          } catch (err) {
            this.logger.error('Error inserting questionLevelRelation:', err);
            throw new InternalServerErrorException(
              'Failed to insert question-level relations',
            );
          }
        }

        // 3️⃣ Insert options & 4️⃣ correct answers
        for (let i = 0; i < insertedQuestions.length; i++) {
          const insertedQ = insertedQuestions[i];
          const originalQ = questions[i];
          if (!originalQ?.options) continue;

          let insertedOptions;

          // Insert options
          try {
            const optionPayloads = Object.entries(originalQ.options).map(
              ([num, text]) => ({
                questionId: insertedQ.id,
                optionText: text,
                optionNumber: Number(num),
              }),
            );

            insertedOptions = await tx
              .insert(mcqQuestionOptions)
              .values(optionPayloads)
              .returning({
                id: mcqQuestionOptions.id,
                optionNumber: mcqQuestionOptions.optionNumber,
              });
          } catch (err) {
            this.logger.error(
              `Error inserting mcqQuestionOptions for questionId ${insertedQ.id}:`,
              err,
            );
            throw new InternalServerErrorException(
              `Failed to insert options for questionId ${insertedQ.id}`,
            );
          }

          // Insert correct answer
          try {
            const correctOptionNumber = Number(originalQ.correctOption);
            const matched = insertedOptions.find(
              (o) => Number(o.optionNumber) === correctOptionNumber,
            );

            if (matched) {
              await tx.insert(correctAnswers).values({
                questionId: insertedQ.id,
                correctOptionId: matched.id,
              });
            } else {
              this.logger.warn(
                `No matching option found for questionId ${insertedQ.id}`,
              );
            }
          } catch (err) {
            this.logger.error(
              `Error inserting correctAnswers for questionId ${insertedQ.id}:`,
              err,
            );
            throw new InternalServerErrorException(
              `Failed to insert correct answer for questionId ${insertedQ.id}`,
            );
          }
        }

        return { insertedQuestions };
      });

      return {
        message:
          'Questions, options and answers (and relations) created successfully',
        data: result,
      };
    } catch (error) {
      this.logger.error('Transaction failed:', error);
      throw new InternalServerErrorException('Failed to create questions');
    }
  }


  async getAllLlmQuestions(aiAssessmentId: number, userId: number) {
  try {

    // ⭐ ADD THIS BLOCK — nothing else changed
    const assessmentStatus = await this.db
      .select()
      .from(studentAssessment)
      .where(
        and(
          eq(studentAssessment.studentId, userId),
          eq(studentAssessment.aiAssessmentId, aiAssessmentId)
        )
      )
      .limit(1);

    const isCompleted =
      assessmentStatus.length > 0 && assessmentStatus[0].status === 1;
    // ⭐ END OF ADDED BLOCK

    const studentLevel = await this.db
      .select({ levelId: studentLevelRelation.levelId })
      .from(studentLevelRelation)
      .where(eq(studentLevelRelation.studentId, userId))
      .limit(1);
    const levelId = studentLevel?.[0]?.levelId;

    // fetch questions by aiAssessmentId  (YOUR CODE)
    const questions = await this.db
      .select()
      .from(questionsByLLM)
      .innerJoin(
        questionLevelRelation,
        eq(questionsByLLM.id, questionLevelRelation.questionId)
      )
      .where(
        and(
          eq(questionsByLLM.aiAssessmentId, aiAssessmentId),
          eq(questionLevelRelation.levelId, levelId)
        )
      )
      .then(rows => rows.map(r => r.questions_by_llm)); // ⭐ unwrap joined rows


    if (!questions || questions.length === 0) {
      return { isCompleted, questions: [] };   // ⭐ only wrapped in object
    }

    // (YOUR EXISTING LOGIC — unchanged)
    const populated = await Promise.all(
      questions.map(async (q) => {
        const options = await this.db
          .select()
          .from(mcqQuestionOptions)
          .where(eq(mcqQuestionOptions.questionId, q.id))
          .orderBy(asc(mcqQuestionOptions.optionNumber));

        const correctRow = await this.db
          .select()
          .from(correctAnswers)
          .where(eq(correctAnswers.questionId, q.id))
          .limit(1);

        let correctOption: CreateMcqQuestionOptionDto | null = null;
        if (correctRow && correctRow.length > 0) {
          const correctOptionRows = await this.db
            .select()
            .from(mcqQuestionOptions)
            .where(eq(mcqQuestionOptions.id, correctRow[0].correctOptionId))
            .limit(1);

          correctOption =
            correctOptionRows && correctOptionRows.length > 0
              ? correctOptionRows[0]
              : null;
        }

        return {
          ...q,
          options,
          correctOption,
        };
      }),
    );

    const randomizedAssessment = randomizeAssessmentQuestions(populated);

    // ⭐ Just add isCompleted to your final response
    return {
      isCompleted,
      questions: randomizedAssessment,
    };

  } catch (error) {
    this.logger.error('Error fetching LLM questions:', error);
    throw new InternalServerErrorException('Failed to fetch LLM questions');
  }
}


  async getAllLlmQuestionsOfAllAssessments(aiAssessmentIds: number[]) {
    try {
      if (!aiAssessmentIds || aiAssessmentIds.length === 0) {
        return [];
      }

      // Fetch all questions that belong to any of the given aiAssessmentIds
      const questions = await this.db
        .select()
        .from(questionsByLLM)
        .where(inArray(questionsByLLM.aiAssessmentId, aiAssessmentIds));

      if (questions.length === 0) {
        return [];
      }

      // Populate options & correct options for each question
      const populated = await Promise.all(
        questions.map(async (q) => {
          // Fetch options for this question
          const options = await this.db
            .select()
            .from(mcqQuestionOptions)
            .where(eq(mcqQuestionOptions.questionId, q.id))
            .orderBy(asc(mcqQuestionOptions.optionNumber));

          // Fetch correct answer (if any)
          const correctRow = await this.db
            .select()
            .from(correctAnswers)
            .where(eq(correctAnswers.questionId, q.id))
            .limit(1);

          let correctOption: CreateMcqQuestionOptionDto | null = null;
          if (correctRow.length > 0) {
            const correctOptionRows = await this.db
              .select()
              .from(mcqQuestionOptions)
              .where(eq(mcqQuestionOptions.id, correctRow[0].correctOptionId))
              .limit(1);

            correctOption =
              correctOptionRows.length > 0 ? correctOptionRows[0] : null;
          }

          return {
            ...q,
            options,
            correctOption,
          };
        }),
      );

      return populated;
    } catch (error) {
      this.logger.error('Error fetching LLM questions:', error);
      throw new InternalServerErrorException('Failed to fetch LLM questions');
    }
  }
  // async getAllLlmQuestions(id) {
  //   try {
  //     const questions = await db.select().from(questionsByLLM);
  //     return questions;
  //   } catch (error) {
  //     this.logger.error('Error fetching LLM questions:', error);
  //     throw new InternalServerErrorException('Failed to fetch LLM questions');
  //   }
  //   // return `This action returns all questionsByLlm`;
  // }

  findOne(id: number) {
    return `This action returns a #${id} questionsByLlm`;
  }

  update(id: number, updateQuestionsByLlmDto: UpdateQuestionsByLlmDto) {
    return `This action updates a #${id} questionsByLlm`;
  }

  remove(id: number) {
    return `This action removes a #${id} questionsByLlm`;
  }
}
