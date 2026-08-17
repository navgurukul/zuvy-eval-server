import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive } from 'class-validator';

export class ReplaceQuestionDto {
  @ApiProperty({ title: 'Question Set ID', description: 'ID of the question set that contains the question to be replaced', example: 253 })
  @IsInt()
  @IsPositive()
  questionSetId: number;

  @ApiProperty({ title: 'Replacement Question ID', description: 'ID of the question that will replace the existing question in the set', example: 1504 })
  @IsInt()
  @IsPositive()
  replacementQuestionId: number;
}
