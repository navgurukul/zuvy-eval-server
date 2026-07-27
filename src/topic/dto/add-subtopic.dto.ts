import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddSubtopicDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subtopic: string;
}
