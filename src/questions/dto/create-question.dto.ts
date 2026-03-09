import { IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class CreateQuestionDto {
  @IsOptional()
  @IsString()
  orgId?: string;

  @IsString()
  domainName: string;

  @IsString()
  topicName: string;

  @IsString()
  topicDescription: string;

  @IsString()
  question: string;

  @IsOptional()
  @IsString()
  difficulty?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsObject()
  options: Record<string, string>;

  @IsInt()
  @Min(1)
  correctOption: number;

  @IsOptional()
  @IsString()
  learningObjectives?: string;

  @IsOptional()
  @IsString()
  targetAudience?: string;

  @IsOptional()
  @IsString()
  focusAreas?: string;

  @IsOptional()
  @IsString()
  bloomsLevel?: string;

  @IsOptional()
  @IsString()
  questionStyle?: string;

  @IsOptional()
  @IsObject()
  difficultyDistribution?: {
    easy?: number;
    medium?: number;
    hard?: number;
  };

  @IsOptional()
  @IsObject()
  questionCounts?: {
    easy?: number;
    medium?: number;
    hard?: number;
  };

  @IsOptional()
  @IsInt()
  levelId?: number | null;
}
