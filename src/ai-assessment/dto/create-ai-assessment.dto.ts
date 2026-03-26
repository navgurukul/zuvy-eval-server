import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

export type AssessmentScope = 'bootcamp' | 'domain';

export class CreateAiAssessmentDto {
  @IsInt()
  @Min(1)
  bootcampId: number;

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
