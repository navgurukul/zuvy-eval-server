import { IsInt, Min } from 'class-validator';

export class MapQuestionsForAssessmentDto {
  @IsInt()
  @Min(1)
  aiAssessmentId: number;
}
