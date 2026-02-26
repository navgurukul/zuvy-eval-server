import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  IVectorStore,
  VectorPoint,
  VectorPayload,
  VectorSearchResult,
} from '../interfaces/vector-store.interface';

@Injectable()
export class QdrantVectorStore implements IVectorStore {
  private readonly logger = new Logger(QdrantVectorStore.name);
  private readonly client: QdrantClient;

  constructor(private readonly config: ConfigService) {
    const url =
      this.config.get<string>('QDRANT_URL') ||
      this.config.get<string>('VECTOR_QDRANT_URL') ||
      process.env.QDRANT_URL ||
      process.env.VECTOR_QDRANT_URL ||
      'http://127.0.0.1:6333';
    this.client = new QdrantClient({ url });
    this.logger.log(`QdrantVectorStore initialized with url=${url}`);
  }

  async ensureCollection(
    collectionName: string,
    vectorSize: number,
  ): Promise<void> {
    const exists = await this.client.collectionExists(collectionName);
    if (exists) return;
    await this.client.createCollection(collectionName, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
    this.logger.log(`Created collection ${collectionName} (size=${vectorSize})`);
  }

  async upsert(collectionName: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    const qdrantPoints = points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload ?? {},
    }));
    await this.client.upsert(collectionName, {
      wait: true,
      points: qdrantPoints,
    });
    this.logger.debug(`Upserted ${points.length} points into ${collectionName}`);
  }

  async search(
    collectionName: string,
    queryVector: number[],
    options?: { limit?: number; filter?: VectorPayload },
  ): Promise<VectorSearchResult[]> {
    const limit = options?.limit ?? 10;
    const filter = options?.filter
      ? {
          must: Object.entries(options.filter).map(([k, v]) => ({
            key: k,
            match: { value: v },
          })),
        }
      : undefined;
    const result = await this.client.search(collectionName, {
      vector: queryVector,
      limit,
      filter,
    });
    return result.map((r) => ({
      id: String(r.id),
      score: r.score ?? 0,
      payload: (r.payload as VectorPayload) ?? undefined,
    }));
  }

  async delete(collectionName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete(collectionName, {
      wait: true,
      points: ids,
    });
    this.logger.debug(`Deleted ${ids.length} points from ${collectionName}`);
  }
}
