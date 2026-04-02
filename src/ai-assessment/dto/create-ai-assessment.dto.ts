import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export type AssessmentScope = 'bootcamp' | 'domain';

export class CreateAiAssessmentDto {
  @IsInt()
  @Min(1)
  bootcampId: number;

  @IsInt()
  @Min(1)
  chapterId: number;

  @IsEnum(['bootcamp', 'domain'])
  @IsOptional()
  scope?: AssessmentScope = 'bootcamp';

  @ValidateIf((o) => o.scope === 'domain')
  @IsInt()
  @Min(1)
  domainId?: number;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  audience?: any;

  @IsInt()
  @Min(1)
  totalNumberOfQuestions: number;

  @IsOptional()
  @IsDateString()
  startDatetime?: string;

  @IsOptional()
  @IsDateString()
  endDatetime?: string;
}

export class ScheduleAssessmentDto {
  @IsDateString()
  startDatetime: string;

  @IsOptional()
  @IsDateString()
  endDatetime?: string;
}

export class PublishAssessmentDto {
  @IsOptional()
  @IsDateString()
  endDatetime?: string;
}

// Backwards-compat types used elsewhere in the module.
export class GenerateAssessmentDto {
  @IsInt()
  @Min(1)
  aiAssessmentId: number;

  @IsInt()
  @Min(1)
  bootcampId: number;
}

export class SubmitAssessmentDto {
  // left unchanged from existing usage; the full shape already lives in other files.
  aiAssessmentId: number;
  answers: any[];
}

export class ScoreQuestionItemDto {
  @IsInt()
  @Min(1)
  questionId: number;

  @IsInt()
  @Min(1)
  position: number;

  @IsString()
  question: string;

  options: Record<string, string>;

  @IsString()
  difficulty: string;

  @IsString()
  topic: string;

  @IsString()
  language: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  correctOptionSelectedByStudents?: number;
}

export class ScoreSubmitDto {
  @IsInt()
  @Min(1)
  assessmentId: number;

  @IsInt()
  @Min(1)
  courseId: number;

  @IsInt()
  @Min(1)
  domainId: number;

  @IsInt()
  @Min(1)
  chapterId: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ScoreQuestionItemDto)
  questions: ScoreQuestionItemDto[];
}
