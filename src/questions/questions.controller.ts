import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { QuestionsService } from './questions.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { GenerateQuestionsDto } from './dto/generate-questions.dto';
import { generateQuestionsExample } from './swagger_examples/examples';

@ApiTags('Questions')
@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

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
  create(@Body() createQuestionDto: CreateQuestionDto) {
    return this.questionsService.create(createQuestionDto);
  }

  @Get()
  findAll() {
    return this.questionsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.questionsService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateQuestionDto: UpdateQuestionDto) {
    return this.questionsService.update(+id, updateQuestionDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.questionsService.remove(+id);
  }
}
