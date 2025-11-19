import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { QuestionsByLlmService } from './questions-by-llm.service';
import { CreateQuestionsByLlmDto } from './dto/create-questions-by-llm.dto';
import { UpdateQuestionsByLlmDto } from './dto/update-questions-by-llm.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

@ApiTags('questions-by-llm')
@Controller('questions-by-llm')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
export class QuestionsByLlmController {
  constructor(private readonly questionsByLlmService: QuestionsByLlmService) {}

  @Post()
  @ApiOperation({ summary: 'Create a QuestionsByLlm entry' })
  @ApiBody({ type: CreateQuestionsByLlmDto })
  @ApiResponse({
    status: 201,
    description: 'Created successfully',
    type: CreateQuestionsByLlmDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid payload' })
  create(@Body() createQuestionsByLlmDto: CreateQuestionsByLlmDto) {
    return this.questionsByLlmService.create(createQuestionsByLlmDto, 1);
  }

  @Get()
  @ApiOperation({ summary: 'Get all QuestionsByLlm entries' })
  @ApiQuery({
    name: 'aiAssessmentId',
    required: true,
    type: String,
    description: 'Search by ai assessment id',
  })
  @ApiResponse({
    status: 200,
    description: 'List retrieved',
    type: [CreateQuestionsByLlmDto],
  })
  findAll(@Query('aiAssessmentId') id: number) {
    return this.questionsByLlmService.getAllLlmQuestions(id);
  }

  // @Get(':id')
  // // @ApiOperation({ summary: 'Get one QuestionsByLlm entry by id' })
  // // @ApiParam({
  // //   name: 'id',
  // //   type: 'number',
  // //   description: 'Numeric id of the entry',
  // // })
  // // @ApiResponse({
  // //   status: 200,
  // //   description: 'Entry retrieved',
  // //   type: CreateQuestionsByLlmDto,
  // // })
  // // @ApiResponse({ status: 404, description: 'Not found' })
  // findOne(@Param('id', ParseIntPipe) id: number) {
  //   return this.questionsByLlmService.findOne(id);
  // }

  // @Patch(':id')
  // // @ApiOperation({ summary: 'Update a QuestionsByLlm entry' })
  // // @ApiParam({
  // //   name: 'id',
  // //   type: 'number',
  // //   description: 'Numeric id of the entry',
  // // })
  // // @ApiBody({ type: UpdateQuestionsByLlmDto })
  // // @ApiResponse({
  // //   status: 200,
  // //   description: 'Updated successfully',
  // //   type: UpdateQuestionsByLlmDto,
  // // })
  // // @ApiResponse({ status: 400, description: 'Invalid payload' })
  // // @ApiResponse({ status: 404, description: 'Not found' })
  // update(
  //   @Param('id', ParseIntPipe) id: number,
  //   @Body() updateQuestionsByLlmDto: UpdateQuestionsByLlmDto,
  // ) {
  //   return this.questionsByLlmService.update(id, updateQuestionsByLlmDto);
  // }

  // @Delete(':id')
  // // @ApiOperation({ summary: 'Remove a QuestionsByLlm entry' })
  // // @ApiParam({
  // //   name: 'id',
  // //   type: 'number',
  // //   description: 'Numeric id of the entry',
  // // })
  // // @ApiResponse({ status: 200, description: 'Deleted successfully' })
  // // @ApiResponse({ status: 404, description: 'Not found' })
  // remove(@Param('id', ParseIntPipe) id: number) {
  //   return this.questionsByLlmService.remove(id);
  // }
}
