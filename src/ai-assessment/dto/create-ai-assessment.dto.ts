import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsObject,
  IsOptional,
  ValidateNested,
  IsISO8601,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAiAssessmentDto {
  @IsNumber()
  @IsNotEmpty()
  bootcampId: number;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsObject()
  @IsNotEmpty()
  topics: Record<string, number>;

  // add start date and end date
  @ApiProperty({
    type: String,
    example: '2025-05-21T10:00:00',
    description: 'Optional. When the assessment becomes active for taking',
  })
  @IsOptional()
  @IsISO8601()
  startDatetime?: string;

  @ApiProperty({
    type: String,
    example: '2025-05-21T11:30:00',
    description: 'Optional. When the assessment expires',
  })
  @IsOptional()
  @IsISO8601()
  endDatetime?: string;

  @IsNumber()
  @IsNotEmpty()
  totalNumberOfQuestions: number;
}

export class SelectedAnswerByStudentDto {
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @IsNumber()
  @IsNotEmpty()
  questionId: number;

  @IsString()
  @IsNotEmpty()
  optionText: string;

  @IsNumber()
  @IsNotEmpty()
  optionNumber: number;
}
class QuestionAnswerDto {
  @IsNumber()
  @IsNotEmpty()
  id: number;

  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsOptional()
  topic?: string;

  @IsString()
  @IsOptional()
  difficulty?: string;

  @ValidateNested()
  @Type(() => SelectedAnswerByStudentDto)
  options: SelectedAnswerByStudentDto;

  @ValidateNested()
  @Type(() => SelectedAnswerByStudentDto)
  selectedAnswerByStudent: SelectedAnswerByStudentDto;

  @IsString()
  @IsOptional()
  language?: string;
}

export class SubmitAssessmentDto {
  @IsArray()
  @IsNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => QuestionAnswerDto)
  answers: QuestionAnswerDto[];

  @IsNumber()
  aiAssessmentId: number;
}

export class GenerateAssessmentDto {
  @IsNumber()
  @IsNotEmpty()
  aiAssessmentId: number;

  @IsNumber()
  @IsNotEmpty()
  bootcampId: number;
}
