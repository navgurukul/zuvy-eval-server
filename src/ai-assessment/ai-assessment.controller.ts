import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Req,
  UseGuards,
  Query,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { AiAssessmentService } from './ai-assessment.service';
import {
  CreateAiAssessmentDto,
  GenerateAssessmentDto,
  ScheduleAssessmentDto,
  PublishAssessmentDto,
  SubmitAssessmentDto,
  ScoreSubmitDto,
} from './dto/create-ai-assessment.dto';
import { UpdateAiAssessmentDto } from './dto/update-ai-assessment.dto';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import {
  createAiAssessmentBootcamp,
  mapQuestionsExample,
  submitAssessmentExample,
  scoreSubmitExample,
  scheduleAssessmentExample,
  scheduleAssessmentNoEndExample,
  publishAssessmentExample,
  publishAssessmentNoEndExample,
} from './swagger_examples/examples';
import { MapQuestionsForAssessmentDto } from './dto/map-questions.dto';
import { AiAssessmentCrudService } from './ai-assessment.crud.service';
import { AiAssessmentMappingService } from './ai-assessment.mapping.service';
import { VectorService } from 'src/vector/vector.service';
import { ExplainQuestionDto } from './dto/explain-question.dto';
import { QuestionExplanationService } from './question-explanation.service';

@ApiTags('AI Assessment')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('ai-assessment')
export class AiAssessmentController {
  constructor(
    private readonly aiAssessmentService: AiAssessmentService,
    private readonly aiAssessmentCrudService: AiAssessmentCrudService,
    private readonly aiAssessmentMappingService: AiAssessmentMappingService,
    private readonly vectorService: VectorService,
    private readonly questionExplanationService: QuestionExplanationService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new AI assessment' })
  @ApiBody({
    type: CreateAiAssessmentDto,
    examples: {
      basicExample: {
        summary: 'Create assessment with poolTopics and moduleId',
        value: createAiAssessmentBootcamp,
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'AI assessment successfully created.',
  })
  @ApiResponse({ status: 400, description: 'Invalid input data.' })
  create(@Body() createAiAssessmentDto: CreateAiAssessmentDto, @Req() req) {
    const userId = req.user?.sub;
    return this.aiAssessmentCrudService.create(userId, createAiAssessmentDto);
  }

  // @Post('/generate/all')
  // @ApiOperation({ summary: 'Generate mcqs' })
  // @ApiBody({
  //   type: Object,
  //   examples: {
  //     basicExample: {
  //       summary: 'Generate Mcqs.',
  //       value: { aiAssessmentId: 800 },
  //     },
  //   },
  // })
  // @ApiResponse({
  //   status: 200,
  //   description: 'Assessment successfully submitted and evaluated.',
  // })
  // @ApiResponse({ status: 400, description: 'Invalid assessment data.' })
  // generate(@Body() generateAssessmentDto: GenerateAssessmentDto, @Req() req) {
  //   const userId = req.user?.sub;
  //   return this.aiAssessmentCrudService.generate(userId, generateAssessmentDto);
  // }

  @Post('/submit')
  @ApiOperation({ summary: 'Submit an AI assessment for evaluation' })
  @ApiBody({
    type: SubmitAssessmentDto,
    examples: {
      basicExample: {
        summary: 'Example submission with basic coding questions',
        value: submitAssessmentExample,
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Assessment successfully submitted and evaluated.',
  })
  @ApiResponse({ status: 400, description: 'Invalid assessment data.' })
  takeAssessment(@Body() submitAssessmentDto: SubmitAssessmentDto, @Req() req) {
    try {
      const userId = req.user?.sub;
      return this.aiAssessmentService.submitLlmAssessment(
        userId,
        submitAssessmentDto,
      );
    } catch (error) {
      console.error('error in evaluation controller', error);
    }
  }

  @Post('/submit-score')
  @ApiOperation({
    summary:
      'Submit answers and receive score only (no LLM evaluation). Returns score, totalQuestions, and percentage.',
  })
  @ApiBody({
    type: ScoreSubmitDto,
    examples: {
      basicExample: {
        summary: 'Score-only submission',
        value: scoreSubmitExample,
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Score calculated successfully.',
  })
  @ApiResponse({ status: 400, description: 'Invalid payload or assessment not available.' })
  submitScore(@Body() scoreSubmitDto: ScoreSubmitDto, @Req() req) {
    const userId = req.user?.sub;
    return this.aiAssessmentService.submitAndScore(userId, scoreSubmitDto);
  }

  @Get()
  @ApiOperation({
    summary:
      'Get all AI assessments (optionally filter by bootcampId, chapterId, moduleId, and status)',
  })
  @ApiQuery({ name: 'bootcampId', required: false, type: Number })
  @ApiQuery({ name: 'chapterId', required: false, type: Number })
  @ApiQuery({ name: 'moduleId', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'scheduled', 'published'] })
  @ApiResponse({ status: 200, description: 'List of AI assessments.' })
  findAll(
    @Req() req,
    @Query('bootcampId') bootcampId?: number,
    @Query('chapterId') chapterId?: number,
    @Query('moduleId') moduleId?: number,
    @Query('status') status?: string,
  ) {
    const userId = req.user?.sub;
    return this.aiAssessmentCrudService.findAll(
      userId,
      bootcampId,
      chapterId,
      moduleId,
      status,
    );
  }

  @Get('/by/studentId')
  @ApiOperation({
    summary:
      'Get all available AI assessments for the current student, filtered by bootcamp and optionally by chapter/module.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of AI assessments available to the student.',
  })
  @ApiQuery({ name: 'bootcampId', required: true, type: Number })
  @ApiQuery({ name: 'chapterId', required: false, type: Number })
  @ApiQuery({ name: 'moduleId', required: false, type: Number })
  findAllAssessmentOfAStudent(
    @Query('bootcampId') bootcampId: number,
    @Query('chapterId') chapterId?: number,
    @Query('moduleId') moduleId?: number,
    @Req() req?,
  ) {
    const userId = req.user?.sub;
    return this.aiAssessmentService.findAllAssessmentOfAStudent(
      userId,
      bootcampId,
      chapterId,
      moduleId,
    );
  }

  @Get('result')
  @ApiOperation({
    summary:
      'Get persisted submit-score result for the current student (same body as POST /submit-score).',
  })
  @ApiQuery({ name: 'assessmentId', required: true, type: Number })
  @ApiResponse({
    status: 200,
    description:
      'score, totalQuestions, percentage, level, questions — matches submit-score response.',
  })
  @ApiResponse({ status: 404, description: 'Not found or assessment not completed.' })
  @ApiResponse({ status: 400, description: 'Invalid assessmentId.' })
  getSubmitScoreResult(
    @Query('assessmentId') assessmentId: string,
    @Req() req,
  ) {
    const id = Number(assessmentId);
    if (!Number.isFinite(id) || id < 1) {
      throw new HttpException('Invalid assessmentId', HttpStatus.BAD_REQUEST);
    }
    const userId = req.user?.sub;
    return this.aiAssessmentService.getSubmitScoreResult(userId, id);
  }

  @Get('time-status')
  @ApiOperation({
    summary:
      'Check whether an assessment is expired (past end time) and active by calendar (started, not ended).',
  })
  @ApiQuery({ name: 'assessmentId', required: true, type: Number })
  @ApiResponse({
    status: 200,
    description:
      'expired, active, status, startDatetime, endDatetime. Open-ended assessments have no expiry.',
  })
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  @ApiResponse({ status: 400, description: 'Invalid assessmentId.' })
  getAssessmentTimeStatus(@Query('assessmentId') assessmentId: string) {
    const id = Number(assessmentId);
    if (!Number.isFinite(id) || id < 1) {
      throw new HttpException('Invalid assessmentId', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentService.getAssessmentTimeStatus(id);
  }

  @Post('questions/explain')
  @ApiOperation({
    summary:
      'Get or generate a cached explanation for why the correct MCQ option is correct (one LLM call per question globally).',
  })
  @ApiBody({ type: ExplainQuestionDto })
  @ApiResponse({
    status: 200,
    description: '{ questionId, explanation, cached } — cached true when loaded from DB.',
  })
  @ApiResponse({ status: 403, description: 'Question not part of this student assessment.' })
  @ApiResponse({ status: 404, description: 'No assignment or question not found.' })
  explainQuestion(@Body() dto: ExplainQuestionDto, @Req() req) {
    const userId = req.user?.sub;
    return this.questionExplanationService.getOrCreateQuestionExplanation(
      userId,
      dto.assessmentId,
      dto.questionId,
    );
  }

  @Get(':id/my-questions')
  @ApiOperation({
    summary:
      "Get the current student's assigned questions for a specific assessment (without correct answers).",
  })
  @ApiResponse({
    status: 200,
    description:
      'Questions assigned to the student for this assessment.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'AI Assessment ID' })
  getStudentQuestions(@Param('id') id: number, @Req() req) {
    const userId = req.user?.sub;
    return this.aiAssessmentService.getStudentQuestions(userId, +id);
  }

  @Post('audio')
  @ApiOperation({ summary: 'Generate audio summary using TTS and upload to S3' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', example: 'This is the assessment summary...' },
        language: { type: 'string', example: 'hi for hindi, kn for kannada and mr for marathi' },
        studentId: { type: 'string', example: 'S12345' },
        assessmentId: { type: 'string', example: 'A98765' },
      },
      required: ['text', 'studentId', 'assessmentId'],
    },
  })
  async generateAudio(
    @Body('text') text: string,
    @Body('language') language: string,
    @Body('studentId') studentId: string,
    @Body('assessmentId') assessmentId: string,
  ) {
    if (!text?.trim()) {
      throw new HttpException('Text is required', HttpStatus.BAD_REQUEST);
    }
    if (!studentId || !assessmentId) {
      throw new HttpException(
        'studentId and assessmentId are required',
        HttpStatus.BAD_REQUEST,
      );
    }
  
    try {
      return await this.aiAssessmentService.generateAudioSummary(
        text,
        language,
        studentId,
        assessmentId,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to generate audio',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id/question-sets')
  @ApiOperation({
    summary:
      'Instructor preview: all generated question sets with full MCQs (includes correct answers). Use after map-questions.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiQuery({ name: 'setId', required: false, type: Number, description: 'Filter by question-set ID' })
  @ApiQuery({ name: 'setIndex', required: false, type: Number, description: 'Filter by set index' })
  @ApiQuery({ name: 'levelCode', required: false, type: String, example: 'E', description: 'Filter by set level code' })
  @ApiQuery({ name: 'topicName', required: false, type: String, description: 'Filter questions by topic name' })
  @ApiQuery({ name: 'difficulty', required: false, type: String, example: 'easy', description: 'Filter questions by difficulty' })
  @ApiQuery({ name: 'questionId', required: false, type: Number, description: 'Filter by question ID' })
  @ApiResponse({ status: 200, description: 'Question sets and questions for the assessment.' })
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  async getQuestionSetsForInstructor(
    @Param('id') id: string,
    @Query('setId') setId?: string,
    @Query('setIndex') setIndex?: string,
    @Query('levelCode') levelCode?: string,
    @Query('topicName') topicName?: string,
    @Query('difficulty') difficulty?: string,
    @Query('questionId') questionId?: string,
  ) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentMappingService.getInstructorQuestionSetsPreview(
      aiAssessmentId,
      {
        setId: setId ? Number(setId) : undefined,
        setIndex: setIndex ? Number(setIndex) : undefined,
        levelCode,
        topicName,
        difficulty,
        questionId: questionId ? Number(questionId) : undefined,
      },
    );
  }

  @Post(':id/draft')
  @ApiOperation({
    summary:
      'Revert assessment to draft. Clears publishedAt, startDatetime, and endDatetime.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, description: 'Assessment reverted to draft.' })
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  async draftAssessment(@Param('id') id: string) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentCrudService.draftAssessment(aiAssessmentId);
  }

  @Post(':id/schedule')
  @ApiOperation({
    summary:
      'Schedule the assessment for a future start. Accepts startDatetime (required) and endDatetime (optional). ' +
      'Students see the assessment once startDatetime arrives. Requires mapped question sets.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    type: ScheduleAssessmentDto,
    examples: {
      withEnd: {
        summary: 'Schedule with start and end',
        value: scheduleAssessmentExample,
      },
      noEnd: {
        summary: 'Schedule with start only (no end date)',
        value: scheduleAssessmentNoEndExample,
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Assessment scheduled.' })
  @ApiResponse({ status: 400, description: 'No question sets or missing startDatetime.' })
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  async scheduleAssessment(
    @Param('id') id: string,
    @Body() dto: ScheduleAssessmentDto,
  ) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentCrudService.scheduleAssessment(
      aiAssessmentId,
      dto.startDatetime,
      dto.endDatetime,
    );
  }

  @Post(':id/publish')
  @ApiOperation({
    summary:
      'Publish the assessment immediately (startDatetime = now). Optionally accepts endDatetime. ' +
      'Requires mapped question sets.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiBody({
    type: PublishAssessmentDto,
    required: false,
    examples: {
      withEnd: {
        summary: 'Publish now with an end date',
        value: publishAssessmentExample,
      },
      noEnd: {
        summary: 'Publish now, no end date (open-ended)',
        value: publishAssessmentNoEndExample,
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Assessment published.' })
  @ApiResponse({ status: 400, description: 'No question sets to publish.' })
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  async publishAssessment(
    @Param('id') id: string,
    @Body() dto: PublishAssessmentDto,
  ) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentCrudService.publishAssessment(
      aiAssessmentId,
      dto?.endDatetime,
    );
  }

  @Post('map-questions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Map (generate) question sets for an assessment via JSON body. ' +
      'Prerequisites: assessment must exist with totalNumberOfQuestions > 0, ' +
      'poolTopics and/or chapterIds+moduleId populated, and questions indexed in QUESTIONS.',
  })
  @ApiBody({
    type: MapQuestionsForAssessmentDto,
    examples: {
      basicExample: {
        summary: 'Map questions for assessment 800',
        value: mapQuestionsExample,
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Question sets generated and mapped successfully for the given assessment.',
  })
  @ApiResponse({ status: 400, description: 'Invalid or missing aiAssessmentId, or totalNumberOfQuestions <= 0.' })
  @ApiResponse({
    status: 404,
    description: 'Assessment not found, or no indexed questions match its topics.',
  })
  async mapQuestionsFromBody(
    @Body() dto: MapQuestionsForAssessmentDto,
    @Req() req: Request & { user?: { orgId?: number | string } },
  ) {
    return this.aiAssessmentMappingService.mapQuestionsForAssessment(
      dto.aiAssessmentId,
      {
        orgId: req.user?.orgId != null ? String(req.user.orgId) : '',
        authorization: req.headers?.authorization,
      },
    );
  }

  @Post(':id/map-questions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Map (generate) question sets for an assessment (path-param variant, kept for backward compatibility)',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: 200,
    description:
      'Question sets generated and mapped successfully for the given assessment.',
  })
  async mapQuestions(
    @Param('id') id: string,
    @Req() req: Request & { user?: { orgId?: number | string } },
  ) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentMappingService.mapQuestionsForAssessment(
      aiAssessmentId,
      {
        orgId: req.user?.orgId != null ? String(req.user.orgId) : '',
        authorization: req.headers?.authorization,
      },
    );
  }

  @Post('admin/create-qdrant-indexes')
  @ApiOperation({ summary: 'One-time: create payload indexes on QUESTIONS collection in Qdrant' })
  @ApiResponse({ status: 200, description: 'Indexes created successfully' })
  async createQdrantIndexes() {
    const collection = 'QUESTIONS';
    await this.vectorService.createPayloadIndex(collection, 'topic', 'keyword');
    await this.vectorService.createPayloadIndex(collection, 'subtopics', 'keyword');
    await this.vectorService.createPayloadIndex(collection, 'difficulty', 'keyword');
    return {
      message: 'Qdrant payload indexes created on QUESTIONS collection',
      fields: ['topic', 'subtopics', 'difficulty'],
    };
  }
}
