import { PartialType } from '@nestjs/swagger';
import { CreateQuestionsByLlmDto } from './create-questions-by-llm.dto';

export class UpdateQuestionsByLlmDto extends PartialType(
  CreateQuestionsByLlmDto,
) {}
