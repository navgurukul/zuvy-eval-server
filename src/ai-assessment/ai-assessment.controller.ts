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
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AiAssessmentService } from './ai-assessment.service';
import {
  CreateAiAssessmentDto,
  GenerateAssessmentDto,
  SubmitAssessmentDto,
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
  createAiAssessmentDomain,
  mapQuestionsExample,
  submitAssessmentExample,
} from './swagger_examples/examples';
import { MapQuestionsForAssessmentDto } from './dto/map-questions.dto';
import { AiAssessmentCrudService } from './ai-assessment.crud.service';
import { AiAssessmentMappingService } from './ai-assessment.mapping.service';
import { VectorService } from 'src/vector/vector.service';

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
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new AI assessment' })
  @ApiBody({
    type: CreateAiAssessmentDto,
    examples: {
      bootcampScope: {
        summary: 'Bootcamp-level assessment (scope defaults to "bootcamp")',
        value: createAiAssessmentBootcamp,
      },
      domainScope: {
        summary: 'Domain-level assessment (scope: "domain", domainId required)',
        value: createAiAssessmentDomain,
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

  @Get()
  @ApiOperation({
    summary: 'Get all AI assessments (optionally filter by bootcampId and chapterId)',
  })
  @ApiQuery({ name: 'bootcampId', required: false, type: Number })
  @ApiQuery({ name: 'chapterId', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of AI assessments.' })
  findAll(
    @Req() req,
    @Query('bootcampId') bootcampId?: number,
    @Query('chapterId') chapterId?: number,
  ) {
    const userId = req.user?.sub;
    return this.aiAssessmentCrudService.findAll(userId, bootcampId, chapterId);
  }

  @Get('/by/studentId')
  @ApiOperation({
    summary: 'Get all AI assessments by student id',
  })
  @ApiResponse({
    status: 200,
    description: 'List of AI assessments of a student.',
  })
  @ApiQuery({ name: 'bootcampId', required: false, type: Number })
  findAllAssessmentOfAStudent(
    @Query('bootcampId') bootcampId: number,
    @Req() req,
  ) {
    const userId = req.user?.sub;
    return this.aiAssessmentService.findAllAssessmentOfAStudent(
      userId,
      bootcampId,
    );
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
  @ApiResponse({ status: 200, description: 'Question sets and questions for the assessment.' })
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  async getQuestionSetsForInstructor(@Param('id') id: string) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentMappingService.getInstructorQuestionSetsPreview(
      aiAssessmentId,
    );
  }

  @Post(':id/publish')
  @ApiOperation({
    summary:
      'Publish mapped question sets as final (students may only start attempts after this, once you wire checks). Cleared automatically if map-questions is run again.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, description: 'Assessment published.' })
  @ApiResponse({ status: 400, description: 'No question sets to publish.' })
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  async publishAssessment(@Param('id') id: string) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentCrudService.publishMappedQuestionSets(
      aiAssessmentId,
    );
  }

  @Post('map-questions')
  @ApiOperation({
    summary:
      'Map (generate) question sets for an assessment via JSON body. ' +
      'Prerequisites: assessment must exist with totalNumberOfQuestions > 0, ' +
      'topics array populated, and questions indexed in the QUESTIONS vector collection.',
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
  @ApiResponse({ status: 404, description: 'Assessment not found.' })
  async mapQuestionsFromBody(
    @Body() dto: MapQuestionsForAssessmentDto,
  ) {
    return this.aiAssessmentMappingService.mapQuestionsForAssessment(
      dto.aiAssessmentId,
    );
  }

  @Post(':id/map-questions')
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
  async mapQuestions(@Param('id') id: string) {
    const aiAssessmentId = Number(id);
    if (Number.isNaN(aiAssessmentId)) {
      throw new HttpException('Invalid assessment id', HttpStatus.BAD_REQUEST);
    }
    return this.aiAssessmentMappingService.mapQuestionsForAssessment(
      aiAssessmentId,
    );
  }

  @Post('admin/create-qdrant-indexes')
  @ApiOperation({ summary: 'One-time: create payload indexes on QUESTIONS collection in Qdrant' })
  @ApiResponse({ status: 200, description: 'Indexes created successfully' })
  async createQdrantIndexes() {
    const collection = 'QUESTIONS';
    await this.vectorService.createPayloadIndex(collection, 'domainName', 'keyword');
    await this.vectorService.createPayloadIndex(collection, 'topicName', 'keyword');
    await this.vectorService.createPayloadIndex(collection, 'difficulty', 'keyword');
    return { message: 'Qdrant payload indexes created on QUESTIONS collection', fields: ['domainName', 'topicName', 'difficulty'] };
  }
}
