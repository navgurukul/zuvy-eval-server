import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PerTopicCountsDto {
  @IsOptional()
  @IsInt()
  easy?: number;

  @IsOptional()
  @IsInt()
  medium?: number;

  @IsOptional()
  @IsInt()
  hard?: number;
}

export class TopicConfigurationDto {
  @IsString()
  topicName: string;

  @IsString()
  topicDescription: string;

  @IsInt()
  @Min(1)
  totalQuestions: number;

  @IsOptional()
  @IsObject()
  difficultyDistribution?: PerTopicCountsDto;

  @IsOptional()
  @IsObject()
  questionCounts?: PerTopicCountsDto;
}

export class GenerateQuestionsDto {
  @IsString()
  domainName: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  topicNames?: string[];

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

  // Legacy simple map of topic -> totalQuestions; accepted but not used for logic.
  @IsOptional()
  @IsObject()
  topics?: Record<string, number>;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TopicConfigurationDto)
  topicConfigurations: TopicConfigurationDto[];

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
