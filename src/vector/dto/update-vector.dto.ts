import { PartialType } from '@nestjs/swagger';
import { UpsertVectorsDto } from './create-vector.dto';

export class UpdateVectorDto extends PartialType(UpsertVectorsDto) {}
