import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CreateAiAssessmentDto,
  GenerateAssessmentDto,
} from './dto/create-ai-assessment.dto';
import { UpdateAiAssessmentDto } from './dto/update-ai-assessment.dto';
import { zuvyBatchEnrollments, users } from 'src/db/schema/parentSchema';
import { questionStudentAnswerRelation } from 'src/db/schema/questionStdAns';
import { studentAnswers } from 'src/db/schema/studentAnswer';
import { studentLevelRelation } from 'src/db/schema/studentLevel';
import { levels } from 'src/db/schema/level';
import { aiAssessment } from 'src/db/schema/ai-assessment';
import { correctAnswers } from 'src/db/schema/correctAns';
import { studentAssessment } from 'src/db/schema/stdAssessment';
import { SubmitAssessmentDto, ScoreSubmitDto } from './dto/create-ai-assessment.dto';
import { LlmService } from 'src/llm/llm.service';
import {
  answerEvaluationPrompt,
  generateMcqPrompt,
} from './system_prompts/system_prompts';
import { parseLlmEvaluation } from 'src/llm/llm_response_parsers/evaluationParser';
import { QuestionEvaluationService } from 'src/questions-by-llm/question-evaluation.service';
import { eq, and, or, asc, desc, inArray, sum, sql } from 'drizzle-orm';
import { aiAssessmentQuestions } from './ai-assessment.questions.schema';
import { zuvyQuestions } from 'src/questions/schema/zuvy-questions.schema';
import { parseLlmMcq } from 'src/llm/llm_response_parsers/mcqParser';
import { QuestionsByLlmService } from 'src/questions-by-llm/questions-by-llm.service';
import { DRIZZLE_DB } from 'src/db/constant';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { LLMUsageService } from 'src/llm/llmUsage.service';
import { StorageService } from 'src/storage/storage.service';
// import { encode } from '@toon-format/toon';

@Injectable()
export class AiAssessmentService {
  private readonly logger = new Logger(AiAssessmentService.name);
  constructor(
    private readonly llmService: LlmService,
    private readonly questionEvaluationService: QuestionEvaluationService,
    private readonly questionByLlmService: QuestionsByLlmService,
    private readonly storageService: StorageService,
    private readonly llmUsageService: LLMUsageService,
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase
  ) {}

   async saveTokenUsage(aiAssessmentId: number, response: any) {
    const usageData = {
      aiAssessmentId,
      provider: response?.provider ?? "openai",
      prompt: response?.request?.messages?.map(m => m.content).join("\n") ?? "",
      responseText: response?.message?.content ?? "",
      latencyMs: response?.latencyMs ?? 0,
      usage: response?.usage ?? null,
      createdAt: new Date()
    };

    await this.llmUsageService.save(usageData);
  }

  async countScore(submitAssessmentDto: SubmitAssessmentDto) {
    const { answers } = submitAssessmentDto;
    let score = 0;

    for (const q of answers) {
      if (!q.selectedAnswerByStudent) continue;
      const correct = await this.db
        .select()
        .from(correctAnswers)
        .where(
          and(
            eq(correctAnswers.questionId, q.id),
            eq(correctAnswers.correctOptionId, q.selectedAnswerByStudent.id),
          ),
        )
        .limit(1);

      if (correct.length > 0) {
        score++;
      }
    }
    return { score, totalQuestions: answers.length };
  }

  async submitAndScore(studentId: number, dto: ScoreSubmitDto) {
    const { assessmentId, questions } = dto;

    return await this.db.transaction(async (tx) => {
      const [assessmentRow] = await tx
        .select({
          status: aiAssessment.status,
          startDatetime: aiAssessment.startDatetime,
          bootcampId: aiAssessment.bootcampId,
        })
        .from(aiAssessment)
        .where(eq(aiAssessment.id, assessmentId))
        .limit(1);

      if (
        !assessmentRow ||
        !this.isAssessmentAvailable(assessmentRow.status, assessmentRow.startDatetime)
      ) {
        throw new BadRequestException('Assessment is not yet available');
      }

      // 1. Batch-fetch correct options from zuvy_questions
      const questionIds = questions.map((q) => q.questionId);
      const correctRows = await tx
        .select({
          id: zuvyQuestions.id,
          correctOption: zuvyQuestions.correctOption,
        })
        .from(zuvyQuestions)
        .where(inArray(zuvyQuestions.id, questionIds));

      const correctMap = new Map<number, number>();
      for (const row of correctRows) {
        correctMap.set(row.id, row.correctOption);
      }

      // 2. Score and build per-question details
      let score = 0;
      const totalQuestions = questions.length;

      const questionDetails = questions.map((q) => {
        const correctOption = correctMap.get(q.questionId) ?? null;
        const selectedOption = q.correctOptionSelectedByStudents ?? null;
        const isCorrect =
          selectedOption !== null &&
          correctOption !== null &&
          selectedOption === correctOption;

        if (isCorrect) score++;

        return {
          questionId: q.questionId,
          correctOption,
          selectedOption,
          isCorrect,
        };
      });

      const percentage =
        totalQuestions > 0
          ? Math.round((score / totalQuestions) * 100 * 100) / 100
          : 0;

      // 3. Save student answers
      const answerPayloads = questionDetails.map((detail) => ({
        studentId,
        aiAssessmentId: assessmentId,
        questionId: detail.questionId,
        selectedOption: detail.selectedOption,
        isCorrect: detail.isCorrect ? 1 : 0,
        answeredAt: new Date().toISOString(),
      }));

      await Promise.all(
        answerPayloads.map((payload) =>
          tx.insert(studentAnswers).values(payload),
        ),
      );

      // 4. Update student_assessment status to completed
      await tx
        .update(studentAssessment)
        .set({
          status: 1,
          updatedAt: new Date().toISOString(),
        } as any)
        .where(
          and(
            eq(studentAssessment.studentId, studentId),
            eq(studentAssessment.aiAssessmentId, assessmentId),
          ),
        );

      // 5. Calculate level and persist
      const level = await this.calculateStudentLevel(percentage);

      await tx.insert(studentLevelRelation).values({
        studentId,
        levelId: level.id,
        aiAssessmentId: assessmentId,
        bootcampId: assessmentRow.bootcampId,
        assignedAt: new Date().toISOString(),
      });

      return {
        score,
        totalQuestions,
        percentage,
        level: {
          grade: level.grade,
          meaning: level.meaning,
          hardship: level.hardship,
        },
        questions: questionDetails,
      };
    });
  }

  async getSubmitScoreResult(studentId: number, assessmentId: number) {
    const [assignment] = await this.db
      .select({
        status: studentAssessment.status,
        questionSetId: studentAssessment.questionSetId,
      })
      .from(studentAssessment)
      .where(
        and(
          eq(studentAssessment.studentId, studentId),
          eq(studentAssessment.aiAssessmentId, assessmentId),
        ),
      )
      .limit(1);

    if (!assignment || assignment.status !== 1) {
      throw new NotFoundException(
        'Assessment result not found or not completed',
      );
    }

    const answerRows = await this.db
      .select({
        questionId: studentAnswers.questionId,
        selectedOption: studentAnswers.selectedOption,
      })
      .from(studentAnswers)
      .where(
        and(
          eq(studentAnswers.studentId, studentId),
          eq(studentAnswers.aiAssessmentId, assessmentId),
        ),
      );

    if (!answerRows.length) {
      throw new NotFoundException('Assessment result not found');
    }

    const questionIds = answerRows.map((r) => r.questionId);
    const correctRows = await this.db
      .select({
        id: zuvyQuestions.id,
        correctOption: zuvyQuestions.correctOption,
      })
      .from(zuvyQuestions)
      .where(inArray(zuvyQuestions.id, questionIds));

    const correctMap = new Map<number, number>();
    for (const row of correctRows) {
      correctMap.set(row.id, row.correctOption);
    }

    let ordered = [...answerRows];
    if (assignment.questionSetId) {
      const positions = await this.db
        .select({
          questionId: aiAssessmentQuestions.questionId,
          position: aiAssessmentQuestions.position,
        })
        .from(aiAssessmentQuestions)
        .where(
          and(
            eq(
              aiAssessmentQuestions.questionSetId,
              assignment.questionSetId,
            ),
            inArray(aiAssessmentQuestions.questionId, questionIds),
          ),
        );

      const posMap = new Map(
        positions.map((p) => [p.questionId, p.position] as const),
      );
      ordered.sort((a, b) => {
        const pa = posMap.get(a.questionId) ?? 999999;
        const pb = posMap.get(b.questionId) ?? 999999;
        if (pa !== pb) return pa - pb;
        return a.questionId - b.questionId;
      });
    } else {
      ordered.sort((a, b) => a.questionId - b.questionId);
    }

    const questionDetails = ordered.map((r) => {
      const correctOption = correctMap.get(r.questionId) ?? null;
      const selectedOption = r.selectedOption ?? null;
      const isCorrect =
        selectedOption !== null &&
        correctOption !== null &&
        selectedOption === correctOption;

      return {
        questionId: r.questionId,
        correctOption,
        selectedOption,
        isCorrect,
      };
    });

    let score = 0;
    for (const q of questionDetails) {
      if (q.isCorrect) score++;
    }
    const totalQuestions = questionDetails.length;
    const percentage =
      totalQuestions > 0
        ? Math.round((score / totalQuestions) * 100 * 100) / 100
        : 0;

    const [levelFromDb] = await this.db
      .select({
        grade: levels.grade,
        meaning: levels.meaning,
        hardship: levels.hardship,
      })
      .from(studentLevelRelation)
      .innerJoin(levels, eq(studentLevelRelation.levelId, levels.id))
      .where(
        and(
          eq(studentLevelRelation.studentId, studentId),
          eq(studentLevelRelation.aiAssessmentId, assessmentId),
        ),
      )
      .orderBy(desc(studentLevelRelation.id))
      .limit(1);

    let levelPayload: { grade: string; meaning: string | null; hardship: string | null };
    if (levelFromDb) {
      levelPayload = levelFromDb;
    } else {
      const level = await this.calculateStudentLevel(percentage);
      levelPayload = {
        grade: level.grade,
        meaning: level.meaning,
        hardship: level.hardship,
      };
    }

    return {
      score,
      totalQuestions,
      percentage,
      level: levelPayload,
      questions: questionDetails,
    };
  }

  private isAssessmentAvailable(
    status: string,
    startDatetime: string | null,
  ): boolean {
    if (status === 'published') return true;
    if (status === 'scheduled') {
      if (!startDatetime) return false;
      return new Date(startDatetime) <= new Date();
    }
    return false;
  }

  async submitLlmAssessment(
    studentId: number,
    submitAssessmentDto: SubmitAssessmentDto,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const { answers, aiAssessmentId } = submitAssessmentDto;

        const [assessmentRow] = await this.db
          .select({
            status: aiAssessment.status,
            startDatetime: aiAssessment.startDatetime,
          })
          .from(aiAssessment)
          .where(eq(aiAssessment.id, aiAssessmentId))
          .limit(1);

        if (
          !assessmentRow ||
          !this.isAssessmentAvailable(assessmentRow.status, assessmentRow.startDatetime)
        ) {
          throw new BadRequestException('Assessment is not yet available');
        }

        const { score, totalQuestions } =
          await this.countScore(submitAssessmentDto);
        const totalScore = (score / totalQuestions) * 100;

        // Prepare payloads
        const answerPayloads = answers.map((q) => ({
          studentId,
          questionId: q.id,
          answer: q.selectedAnswerByStudent?.id ?? null,
          answeredAt: new Date().toISOString(),
        }));

        await Promise.all(
          answerPayloads.map((payload) =>
            tx.insert(questionStudentAnswerRelation).values(payload),
          ),
        );

        const level = await this.calculateStudentLevel(totalScore);
        const bootcamp = await this.db
          .select({ bootcampId: aiAssessment.bootcampId })
          .from(aiAssessment)
          .where(eq(aiAssessment.id, aiAssessmentId))
          .limit(1);

        const bootcampId = bootcamp?.[0]?.bootcampId;

        const levelPayload = {
          studentId,
          levelId: level.id,
          aiAssessmentId,
          bootcampId,
          assignedAt: new Date().toISOString(),
        };

        await tx.insert(studentLevelRelation).values(levelPayload);

        //here evaluate the answers by the LLM.
        // const encodedQuestionWithAsnwers = encode(answers);
        // const evaluationPrompt = answerEvaluationPrompt(
        //   encodedQuestionWithAsnwers,
        // );

        await tx
          .update(studentAssessment)
          .set({
            status: 1, // completed
            updatedAt: new Date().toISOString(),
          } as any)
          .where(
            and(
              eq(studentAssessment.studentId, studentId),
              eq(studentAssessment.aiAssessmentId, aiAssessmentId),
            ),
          );

        const evaluationPrompt = answerEvaluationPrompt(answers);
        const llmResponse = await this.llmService.generateCompletion(evaluationPrompt);
        const responseText = llmResponse.text;
        const aiUsage = await this.saveTokenUsage(aiAssessmentId, llmResponse);

        let rawEvaluationText: string | null = null;
        if (!responseText) rawEvaluationText = null;
        else if (typeof responseText === 'string')
          rawEvaluationText = responseText;
        else if (typeof llmResponse === 'object') {
          rawEvaluationText =
            (llmResponse as any).text ??
            (llmResponse as any).content ??
            (llmResponse as any).response ??
            (llmResponse as any).output ??
            JSON.stringify(llmResponse);
        } else {
          rawEvaluationText = String(responseText);
        }

        // Parse & validate BEFORE returning to client
        let parsedEvaluation: any = null;
        let parseError: string | null = null;

        if (rawEvaluationText) {
          try {
            parsedEvaluation = parseLlmEvaluation(rawEvaluationText);
          } catch (err) {
            parseError = (err as Error).message;
          }
        } else {
          parseError = 'Empty LLM response.';
        }

        // Optionally: persist parsedEvaluation to DB here if successful
        // if (parsedEvaluation) { await db.insert(...).values({ ... }) }
        await this.questionEvaluationService.saveEvaluations(
          parsedEvaluation,
          studentId,
          aiAssessmentId,
        );

        return {
          totalQuestions,
          score: Math.round(score * 100) / 100,
          level: level.grade,
          performance: level.meaning,
          hardship: level.hardship,
          evaluation: parsedEvaluation ?? null,
          rawEvaluationText: parsedEvaluation ? null : rawEvaluationText,
          parseError,
        };
      });
    } catch (error) {
      this.logger.error(
        'Error submitting LLM assessment:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async calculateStudentLevel(score: number) {
    const allLevels = await this.db.select().from(levels); // Renamed to avoid conflict

    const level = allLevels.find((level) => {
      const min = level.scoreMin ?? -Infinity;
      const max = level.scoreMax ?? Infinity;

      if (level.grade === 'A+') {
        return score >= min;
      } else if (level.grade === 'E') {
        return score <= max;
      } else {
        return score >= min && score <= max;
      }
    });

    if (!level) {
      // Default to E level if no match found
      return (
        allLevels.find((l) => l.grade === 'E') ||
        allLevels[allLevels.length - 1]
      );
    }

    return level;
  }

  async findAllAssessmentOfAStudent(
    userId: number,
    bootcampId: number | string,
    chapterId?: number | string,
    domainId?: number | string,
  ) {
    if (!userId) return [];

    const parsedBootcampId = Number(bootcampId);
    if (Number.isNaN(parsedBootcampId)) return [];

    const conditions: any[] = [
      eq(studentAssessment.studentId, Number(userId)),
      eq(aiAssessment.bootcampId, parsedBootcampId),
      or(
        eq(aiAssessment.status, 'published'),
        and(
          eq(aiAssessment.status, 'scheduled'),
          sql`${aiAssessment.startDatetime} <= now()`,
        ),
      ),
    ];

    const parsedChapterId =
      chapterId !== undefined && chapterId !== null && chapterId !== ''
        ? Number(chapterId)
        : undefined;
    const parsedDomainId =
      domainId !== undefined && domainId !== null && domainId !== ''
        ? Number(domainId)
        : undefined;

    if (typeof parsedChapterId === 'number' && !Number.isNaN(parsedChapterId)) {
      conditions.push(eq(aiAssessment.chapterId, parsedChapterId));
    }
    if (typeof parsedDomainId === 'number' && !Number.isNaN(parsedDomainId)) {
      conditions.push(eq(aiAssessment.domainId, parsedDomainId));
    }

    const assessments = await this.db
      .select({
        id: aiAssessment.id,
        bootcampId: aiAssessment.bootcampId,
        chapterId: aiAssessment.chapterId,
        domainId: aiAssessment.domainId,
        title: aiAssessment.title,
        description: aiAssessment.description,
        totalNumberOfQuestions: aiAssessment.totalNumberOfQuestions,
        startDatetime: aiAssessment.startDatetime,
        endDatetime: aiAssessment.endDatetime,
        assessmentStatus: aiAssessment.status,
        studentStatus: studentAssessment.status,
        questionSetId: studentAssessment.questionSetId,
      })
      .from(studentAssessment)
      .innerJoin(
        aiAssessment,
        eq(studentAssessment.aiAssessmentId, aiAssessment.id),
      )
      .where(and(...conditions));

    return assessments;
  }

  async getStudentQuestions(userId: number, aiAssessmentId: number) {
    const rows = await this.db
      .select({
        studentStatus: studentAssessment.status,
        questionSetId: studentAssessment.questionSetId,
        assessmentStatus: aiAssessment.status,
        startDatetime: aiAssessment.startDatetime,
      })
      .from(studentAssessment)
      .innerJoin(
        aiAssessment,
        eq(studentAssessment.aiAssessmentId, aiAssessment.id),
      )
      .where(
        and(
          eq(studentAssessment.studentId, userId),
          eq(studentAssessment.aiAssessmentId, aiAssessmentId),
        ),
      )
      .limit(1);

    if (!rows.length) {
      throw new NotFoundException(
        'No assessment assignment found for this student',
      );
    }

    const row = rows[0];

    if (
      !this.isAssessmentAvailable(row.assessmentStatus, row.startDatetime)
    ) {
      throw new BadRequestException('Assessment is not yet available');
    }

    if (!row.questionSetId) {
      throw new BadRequestException(
        'No question set has been assigned to this student yet',
      );
    }

    const questions = await this.db
      .select({
        questionId: aiAssessmentQuestions.questionId,
        position: aiAssessmentQuestions.position,
        question: zuvyQuestions.question,
        options: zuvyQuestions.options,
        difficulty: zuvyQuestions.difficulty,
        topic: zuvyQuestions.topicName,
        language: zuvyQuestions.language,
      })
      .from(aiAssessmentQuestions)
      .innerJoin(
        zuvyQuestions,
        eq(aiAssessmentQuestions.questionId, zuvyQuestions.id),
      )
      .where(eq(aiAssessmentQuestions.questionSetId, row.questionSetId))
      .orderBy(asc(aiAssessmentQuestions.position));

    return {
      aiAssessmentId,
      questionSetId: row.questionSetId,
      studentStatus: row.studentStatus,
      questions,
    };
  }

  async getTotalBufferedQuestions(assessmentIds: number[]) {
    try {
      if (!assessmentIds || assessmentIds.length === 0) return 0;

      const [result] = await this.db
        .select({
          totalBufferedQuestions: sum(aiAssessment.totalQuestionsWithBuffer).as(
            'totalBufferedQuestions',
          ),
        })
        .from(aiAssessment)
        .where(inArray(aiAssessment.id, assessmentIds));

      return Number(result?.totalBufferedQuestions || 0);
    } catch (error) {
      this.logger.error('Error fetching total buffered questions:', error);
      throw new InternalServerErrorException(
        'Failed to fetch total buffered questions',
      );
    }
  }

    async generateAudioSummary(
    text: string,
    language: string,
    studentId: string,
    assessmentId: string,
    ) {
      try {
        const audioBuffer = await this.llmService.generateAudioSummary(text, language);
        const {audioUrl} = await this.storageService.uploadAudioToS3(audioBuffer, studentId, assessmentId);

        return { audioUrl };
      } catch (error) {
        this.logger.error(
          `Audio generation failed for student=${studentId}, assessment=${assessmentId}`,
          error.stack,
        );

        throw new InternalServerErrorException(
          'Failed to generate audio. Please try again later.',
        );
    }
  }

}
