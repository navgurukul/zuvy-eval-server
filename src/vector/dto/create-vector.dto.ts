import {
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class VectorPointDto {
  @IsString()
  id: string;

  @IsArray()
  @IsNumber({}, { each: true })
  vector: number[];

  @IsOptional()
  @IsObject()
  payload?: Record<string, string | number | boolean | null>;
}

export class UpsertVectorsDto {
  @IsString()
  collectionName: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VectorPointDto)
  points: VectorPointDto[];
}

export class EnsureCollectionDto {
  @IsString()
  collectionName: string;

  @IsNumber()
  vectorSize: number;
}
