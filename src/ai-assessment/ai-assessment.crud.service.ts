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
import { AiAssessmentService } from './ai-assessment.service';
// import { encode } from '@toon-format/toon';

@Injectable()
export class AiAssessmentCrudService {
  private readonly logger = new Logger(AiAssessmentCrudService.name);
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    private readonly questionByLlmService: QuestionsByLlmService,
    private readonly llmService: LlmService,
    private readonly aiAssessmentService: AiAssessmentService
  ){}

   async getTopicsOfAssessments(assessmentIds: number[]) {
    try {
      if (!assessmentIds || assessmentIds.length === 0) {
        return [];
      }

      const topicsData = await this.db
        .select({
          id: aiAssessment.id,
          topics: aiAssessment.topics,
        })
        .from(aiAssessment)
        .where(inArray(aiAssessment.id, assessmentIds));

      return topicsData;
    } catch (error) {
      this.logger.error('Error fetching topics of assessments:', error);
      throw new InternalServerErrorException(
        'Failed to fetch topics of assessments',
      );
    }
  }

  async findAll(userId: number, bootcampId?: number) {
    const query = this.db.select().from(aiAssessment);

    const results = bootcampId
      ? await query.where(eq(aiAssessment.bootcampId, bootcampId))
      : await query;

    if (bootcampId && results.length === 0) {
      return [];
    }

    return results;
  }

  async getDistinctLevelsByAssessment(aiAssessmentId: number) {
    const results = await this.db
      .select({
        id: levels.id,
        grade: levels.grade,
        scoreRange: levels.scoreRange,
        scoreMin: levels.scoreMin,
        scoreMax: levels.scoreMax,
        hardship: levels.hardship,
        meaning: levels.meaning,
        createdAt: levels.createdAt,
        updatedAt: levels.updatedAt,
      })
      .from(studentLevelRelation)
      .innerJoin(levels, eq(levels.id, studentLevelRelation.levelId))
      .where(eq(studentLevelRelation.aiAssessmentId, aiAssessmentId))
      .groupBy(levels.id);

    return results;
  }

  async getTotalQuestions(assessmentIds: number[]) {
    try {
      if (!assessmentIds || assessmentIds.length === 0) return 0;

      const [result] = await this.db
        .select({
          totalQuestions: sum(aiAssessment.totalNumberOfQuestions).as(
            'totalQuestions',
          ),
        })
        .from(aiAssessment)
        .where(inArray(aiAssessment.id, assessmentIds));

      return Number(result?.totalQuestions || 0);
    } catch (error) {
      this.logger.error('Error fetching total questions:', error);
      throw new InternalServerErrorException('Failed to fetch total questions');
    }
  }

  async generateMcqPromptsForEachLevel(
    levels,
    aiAssessmentId,
    allQuestions,
    topicOfCurrentAssessment,
    totalQuestions,
  ) {
    // const systemPrompts = [];
    if (levels.length == 0) {
      const levelDescription = 'Base Level.';
      // const audience = 'student';
      let previous_mcqs_str;
      let baseLinePrompt = '';
      if (allQuestions.length == 0) {
        previous_mcqs_str =
          'There is no previous assessment for your reference. This is a base line assessment. Hence produce average level questions on the selected topics.';
      } else {
        previous_mcqs_str = JSON.stringify(allQuestions);
      }

      const prompt = generateMcqPrompt(
        'Beginners Level.',
        levelDescription,
        // audience,
        previous_mcqs_str,
        topicOfCurrentAssessment,
        totalQuestions,
      );

      const aiResponse = await this.llmService.generateCompletion(prompt);
      const aiUsage = await this.aiAssessmentService.saveTokenUsage(aiAssessmentId, aiResponse);
      const parsedAiResponse = await parseLlmMcq(aiResponse.text);
      await this.questionByLlmService.create(
        { questions: parsedAiResponse.evaluations, levelId: null },
        aiAssessmentId,
      );
    }
    for (const level of levels) {
      const levelName = level.grade;
      const levelDescription =
        level.meaning || `${levelName} — ${level.scoreRange}`;
      // const audience = 'student';
      let previous_mcqs_str;
      let baseLinePrompt = '';
      if (allQuestions.length == 0) {
        previous_mcqs_str =
          'There is no previous assessment for your reference. This is a base line assessment. Hence produce average level questions on the selected topics.';
      } else {
        previous_mcqs_str = JSON.stringify(allQuestions);
      }

      const prompt = generateMcqPrompt(
        levelName,
        levelDescription,
        // audience,
        previous_mcqs_str,
        topicOfCurrentAssessment,
        totalQuestions,
      );

      const aiResponse = await this.llmService.generateCompletion(prompt);
      const aiUsage = await this.aiAssessmentService.saveTokenUsage(aiAssessmentId, aiResponse);
      const parsedAiResponse = await parseLlmMcq(aiResponse.text);
      await this.questionByLlmService.create(
        { questions: parsedAiResponse.evaluations, levelId: level.id },
        aiAssessmentId,
      );
      // systemPrompts.push({
      //   levelId: level.id,
      //   grade: level.grade,
      //   prompt,
      // });
    }
    // return systemPrompts;
  }

  async generate(userId, generateAssessmentDto: GenerateAssessmentDto) {
    const { aiAssessmentId } = generateAssessmentDto;
    const distinctLevels =
      await this.getDistinctLevelsByAssessment(aiAssessmentId);
    const allAssessmentOfABootcamp = await this.findAll(
      userId,
      generateAssessmentDto.bootcampId,
    );
    const assessmentIds = allAssessmentOfABootcamp.map((a) => a.id);
    const allQuestionsOfAllAssessmentsInABootcamp =
      await this.questionByLlmService.getAllLlmQuestionsOfAllAssessments(
        assessmentIds,
      );
    const topicOfCurrentAssessment = await this.getTopicsOfAssessments([
      generateAssessmentDto.aiAssessmentId,
    ]);
    const totalQuestions = await this.getTotalQuestions([
      generateAssessmentDto.aiAssessmentId,
    ]);
    await this.generateMcqPromptsForEachLevel(
      distinctLevels,
      aiAssessmentId,
      allQuestionsOfAllAssessmentsInABootcamp,
      topicOfCurrentAssessment[0].topics,
      totalQuestions,
    );
  }

  async create(userId, createAiAssessmentDto: CreateAiAssessmentDto) {
    try {
        const { inserted, enrolledStudentsCount } = await this.db.transaction(
        async (tx) => {
            const payload = {
            bootcampId: createAiAssessmentDto.bootcampId,
            title: createAiAssessmentDto.title,
            description: createAiAssessmentDto.description ?? null,
            topics: createAiAssessmentDto.topics,
            // audience: createAiAssessmentDto.audience ?? null,
            totalNumberOfQuestions:
                createAiAssessmentDto.totalNumberOfQuestions,
            totalQuestionsWithBuffer: Math.floor(
                createAiAssessmentDto.totalNumberOfQuestions * 2.25,
            ),
            startDatetime: createAiAssessmentDto.startDatetime,
            endDatetime: createAiAssessmentDto.endDatetime,
            };

            const [aiRow] = await tx
            .insert(aiAssessment)
            .values(payload)
            .returning();

            const enrolledStudents = await tx
            .select({
                studentId: zuvyBatchEnrollments.userId,
            })
            .from(zuvyBatchEnrollments)
            .innerJoin(users, eq(zuvyBatchEnrollments.userId, users.id))
            .where(
                eq(
                zuvyBatchEnrollments.bootcampId,
                createAiAssessmentDto.bootcampId,
                ),
            );

            if (enrolledStudents.length > 0) {
            const studentAssessments = enrolledStudents.map((student) => ({
                studentId: Number(student.studentId),
                aiAssessmentId: aiRow.id,
                status: 0,
            }));
            await tx.insert(studentAssessment).values(studentAssessments);
            }

            return {
            inserted: aiRow,
            enrolledStudentsCount: enrolledStudents.length,
            };
        },
        );

        await this.generate(userId, {
        aiAssessmentId: inserted.id,
        bootcampId: inserted.bootcampId,
        });

        return {
        message:
            'AI Assessment created successfully and assigned to all enrolled students',
        data: inserted,
        totalAssignedStudents: enrolledStudentsCount,
        };
    } catch (error) {
        this.logger.error(
        'Error creating AI assessment:',
        error instanceof Error ? error.message : String(error),
        );
        throw new BadRequestException(
        'Failed to create AI assessment: ' + error.message,
        );
    }
  }
}