import { ArrayNotEmpty, IsArray, IsInt, IsOptional, Min } from 'class-validator';

export class GetTopicDto {
    @IsArray()
    @ArrayNotEmpty()
    @IsInt({ each: true })
    @Min(1, { each: true })
    chapterIds: number[];

    @IsOptional()
    @IsInt()
    bootcampId?: number;

    @IsInt()
    moduleId: number;
}
