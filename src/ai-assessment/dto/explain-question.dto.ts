import { IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExplainQuestionDto {
  @ApiProperty({ example: 137 })
  @IsInt()
  @Min(1)
  assessmentId: number;

  @ApiProperty({ example: 750 })
  @IsInt()
  @Min(1)
  questionId: number;
}
