import {
  IsArray,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
} from 'class-validator';

export class CreateQuestionsByLlmDto {
  @IsArray()
  @IsNotEmpty()
  questions: {
    question: string;
    options: object;
    correctOption: number;
    difficulty?: string;
    topic?: string;
    language?: string;
  }[];

  @IsString()
  @IsOptional()
  levelId?: string | null;
}

export class CreateMcqQuestionOptionDto {
  @IsNumber()
  @IsOptional()
  id?: number;

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

export class CreateCorrectAnswerDto {
  @IsNumber()
  @IsNotEmpty()
  questionId: number;

  @IsNumber()
  @IsNotEmpty()
  correctOptionId: number;
}
