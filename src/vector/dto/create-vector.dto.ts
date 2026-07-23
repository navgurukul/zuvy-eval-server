import {
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { VectorPayload } from '../interfaces/vector-store.interface';

export class VectorPointDto {
  @IsString()
  id: string;

  @IsArray()
  @IsNumber({}, { each: true })
  vector: number[];

  @IsOptional()
  @IsObject()
  payload?: VectorPayload;
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
