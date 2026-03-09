import { IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class GenerateQuestionsDto {
  @IsString()
  domainName: string;

  @IsString()
  topicName: string;

  @IsString()
  topicDescription: string;

  @IsInt()
  @Min(1)
  numberOfQuestions: number;

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

  @IsObject()
  topics: Record<string, number>;

  @IsOptional()
  @IsString()
  @IsIn(['A', 'B', 'C', 'D', 'E'])
  levelId?: 'A' | 'B' | 'C' | 'D' | 'E' | null;
}

export interface GenerateTopicBatchJobPayload {
  topic: string;
  count: number;
  orgId?: string;
  levelId?: 'A' | 'B' | 'C' | 'D' | 'E' | null;
  domainName?: string;
  topicName?: string;
  topicDescription?: string;
  learningObjectives?: string;
  targetAudience?: string;
  focusAreas?: string;
  bloomsLevel?: string;
  questionStyle?: string;
  difficultyDistribution?: {
    easy?: number;
    medium?: number;
    hard?: number;
  };
  questionCounts?: {
    easy?: number;
    medium?: number;
    hard?: number;
  };
}
