import { Inject, Injectable } from '@nestjs/common';
import { VECTOR_STORE } from './constants';
import type { IVectorStore } from './interfaces/vector-store.interface';
import { UpsertVectorsDto } from './dto/create-vector.dto';
import { SearchVectorsDto } from './dto/search-vector.dto';

@Injectable()
export class VectorService {
  constructor(
    @Inject(VECTOR_STORE) private readonly store: IVectorStore,
  ) {}

  async ensureCollection(
    collectionName: string,
    vectorSize: number,
  ): Promise<void> {
    return this.store.ensureCollection(collectionName, vectorSize);
  }

  async upsert(dto: UpsertVectorsDto): Promise<void> {
    return this.store.upsert(dto.collectionName, dto.points);
  }

  async search(dto: SearchVectorsDto) {
    return this.store.search(dto.collectionName, dto.queryVector, {
      limit: dto.limit,
      filter: dto.filter,
    });
  }

  async delete(collectionName: string, ids: string[]): Promise<void> {
    return this.store.delete(collectionName, ids);
  }
}
