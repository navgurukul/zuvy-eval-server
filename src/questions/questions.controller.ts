import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { QuestionsService } from './questions.service';
import { QuestionsCrudService } from './questions.crud.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { GenerateQuestionsDto } from './dto/generate-questions.dto';
import { generateQuestionsExample } from './swagger_examples/examples';

@ApiTags('Questions')
@ApiBearerAuth('JWT-auth')
@Controller('questions')
export class QuestionsController {
  constructor(
    private readonly questionsService: QuestionsService,
    private readonly questionsCrudService: QuestionsCrudService,
  ) {}

  @Post('generate')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Enqueue background question generation jobs' })
  @ApiBody({
    type: GenerateQuestionsDto,
    examples: generateQuestionsExample,
  })
  @ApiQuery({ name: 'orgId', required: true, type: String })
  async enqueueGeneration(
    @Req() req: Request & { user?: { sub?: string } },
    @Query('orgId') orgId: string,
    @Body() payload: GenerateQuestionsDto,
  ) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId (query param) is required');
    }
    const requestedByUserId = req.user?.sub != null ? String(req.user.sub) : undefined;
    return this.questionsService.enqueueGeneration(payload, orgId.trim(), requestedByUserId);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Body() createQuestionDto: CreateQuestionDto,
  ) {
    const orgId = req.user?.orgId != null ? String(req.user.orgId) : undefined;
    return this.questionsCrudService.create(orgId ?? '', createQuestionDto);
  }

  @Get()
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'domainName', required: false, type: String })
  @ApiQuery({ name: 'difficulty', required: false, type: String })
  @ApiQuery({ name: 'topicName', required: false, type: String })
  @UseGuards(JwtAuthGuard)
  findAll(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('domainName') domainName?: string,
    @Query('difficulty') difficulty?: string,
    @Query('topicName') topicName?: string,
  ) {
    const orgId = req.user?.orgId != null ? String(req.user.orgId) : undefined;
    return this.questionsCrudService.findAll({
      orgId: orgId ?? '',
      page,
      limit,
      domainName,
      difficulty,
      topicName,
    });
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Param('id') id: string,
  ) {
    const orgId = req.user?.orgId != null ? String(req.user.orgId) : undefined;
    return this.questionsCrudService.findOne(orgId ?? '', Number(id));
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Param('id') id: string,
    @Body() updateQuestionDto: UpdateQuestionDto,
  ) {
    const orgId = req.user?.orgId != null ? String(req.user.orgId) : undefined;
    return this.questionsCrudService.update(orgId ?? '', Number(id), updateQuestionDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Param('id') id: string,
  ) {
    const orgId = req.user?.orgId != null ? String(req.user.orgId) : undefined;
    return this.questionsCrudService.remove(orgId ?? '', Number(id));
  }
}
