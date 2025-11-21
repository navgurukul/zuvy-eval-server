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
import { studentLevelRelation } from 'src/db/schema/studentLevel';
import { levels } from 'src/db/schema/level';
import { aiAssessment } from 'src/db/schema/ai-assessment';
import { correctAnswers } from 'src/db/schema/correctAns';
import { studentAssessment } from 'src/db/schema/stdAssessment';
import { SubmitAssessmentDto } from './dto/create-ai-assessment.dto';
import { LlmService } from 'src/llm/llm.service';
import {
  answerEvaluationPrompt,
  generateMcqPrompt,
} from './system_prompts/system_prompts';
import { parseLlmEvaluation } from 'src/llm/llm_response_parsers/evaluationParser';
import { QuestionEvaluationService } from 'src/questions-by-llm/question-evaluation.service';
import { eq, and, inArray, sum } from 'drizzle-orm';
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

  async submitLlmAssessment(
    studentId: number,
    submitAssessmentDto: SubmitAssessmentDto,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const { answers, aiAssessmentId } = submitAssessmentDto;

        // const totalQuestions = answers.length;
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

        const levelPayload = {
          studentId,
          levelId: level.id,
          aiAssessmentId,
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

  async findAllAssessmentOfAStudent(userId: number, bootcampId) {
    if (!userId) return [];

    const assessments = await this.db
      .select({
        id: aiAssessment.id,
        bootcampId: aiAssessment.bootcampId,
        title: aiAssessment.title,
        description: aiAssessment.description,
        topics: aiAssessment.topics,
        audience: aiAssessment.audience,
        totalNumberOfQuestions: aiAssessment.totalNumberOfQuestions,
        totalQuestionsWithBuffer: aiAssessment.totalQuestionsWithBuffer,
        startDatetime: aiAssessment.startDatetime,
        endDatetime: aiAssessment.endDatetime,
        createdAt: aiAssessment.createdAt,
        updatedAt: aiAssessment.updatedAt,
        status: studentAssessment.status,
      })
      .from(studentAssessment)
      .innerJoin(
        aiAssessment,
        eq(studentAssessment.aiAssessmentId, aiAssessment.id),
      )
      .where(
        and(
          eq(studentAssessment.studentId, userId),
          eq(aiAssessment.bootcampId, bootcampId),
        ),
      );

    if (assessments.length === 0) {
      const defaultAssessment = await this.db
        .select()
        .from(aiAssessment)
        .where(eq(aiAssessment.id, 1))
        .limit(1);
      return defaultAssessment;
    }

    return assessments;
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
