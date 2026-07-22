import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min ,IsObject} from 'class-validator';

export class CreateTopicDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  subtopic?: string;
}
