import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Enqueue background question generation jobs' })
  @ApiBody({
    type: GenerateQuestionsDto,
    examples: generateQuestionsExample,
  })
  @ApiQuery({ name: 'orgId', required: true, type: String })
  async enqueueGeneration(
    @Query('orgId') orgId: string,
    @Body() payload: GenerateQuestionsDto,
  ) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId (query param) is required');
    }
    return this.questionsService.enqueueGeneration(payload, orgId.trim());
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
