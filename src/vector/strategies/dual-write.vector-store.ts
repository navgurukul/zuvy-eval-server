import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IVectorStore,
  VectorPoint,
  VectorPayload,
  VectorSearchResult,
} from '../interfaces/vector-store.interface';
import { QdrantVectorStore } from './qdrant.vector-store';
import { OpenSearchVectorStore } from './opensearch.vector-store';

/**
 * Migration wrapper: writes to both Qdrant and OpenSearch, reads from one.
 *
 * Env:
 *   VECTOR_DB=dual                  enable this store
 *   VECTOR_READ_FROM=qdrant         which store serves reads (default qdrant)
 *   VECTOR_SHADOW_COMPARE=true      also query the other store and log the
 *                                   overlap, without affecting the response
 *
 * Writes to the read store are awaited and their failures propagate. Writes to
 * the other store are logged on failure but never break the request, so a
 * problem with the new store cannot take production down.
 */
@Injectable()
export class DualWriteVectorStore implements IVectorStore {
  private readonly logger = new Logger(DualWriteVectorStore.name);
  private readonly readFrom: 'qdrant' | 'opensearch';
  private readonly shadowCompare: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly qdrant: QdrantVectorStore,
    private readonly opensearch: OpenSearchVectorStore,
  ) {
    this.readFrom =
      (this.config.get<string>('VECTOR_READ_FROM') ??
        process.env.VECTOR_READ_FROM ??
        'qdrant') === 'opensearch'
        ? 'opensearch'
        : 'qdrant';

    this.shadowCompare =
      (this.config.get<string>('VECTOR_SHADOW_COMPARE') ??
        process.env.VECTOR_SHADOW_COMPARE ??
        'false') === 'true';

    this.logger.log(
      `DualWriteVectorStore: writing to both, reading from ${this.readFrom}, ` +
        `shadowCompare=${this.shadowCompare}`,
    );
  }

  private get primary(): IVectorStore {
    return this.readFrom === 'opensearch' ? this.opensearch : this.qdrant;
  }

  private get secondary(): IVectorStore {
    return this.readFrom === 'opensearch' ? this.qdrant : this.opensearch;
  }

  private get secondaryName(): string {
    return this.readFrom === 'opensearch' ? 'qdrant' : 'opensearch';
  }

  /** Run against the non-serving store without ever throwing. */
  private async trySecondary(op: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(
        `Secondary (${this.secondaryName}) ${op} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async ensureCollection(collectionName: string, vectorSize: number): Promise<void> {
    await this.primary.ensureCollection(collectionName, vectorSize);
    await this.trySecondary('ensureCollection', () =>
      this.secondary.ensureCollection(collectionName, vectorSize),
    );
  }

  async upsert(collectionName: string, points: VectorPoint[]): Promise<void> {
    await this.primary.upsert(collectionName, points);
    await this.trySecondary('upsert', () => this.secondary.upsert(collectionName, points));
  }

  async delete(collectionName: string, ids: string[]): Promise<void> {
    await this.primary.delete(collectionName, ids);
    await this.trySecondary('delete', () => this.secondary.delete(collectionName, ids));
  }

  async createPayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: 'keyword' | 'integer' | 'float' | 'bool',
  ): Promise<void> {
    await this.primary.createPayloadIndex(collectionName, fieldName, fieldSchema);
    await this.trySecondary('createPayloadIndex', () =>
      this.secondary.createPayloadIndex(collectionName, fieldName, fieldSchema),
    );
  }

  async search(
    collectionName: string,
    queryVector: number[],
    options?: { limit?: number; filter?: VectorPayload },
  ): Promise<VectorSearchResult[]> {
    const started = Date.now();
    const results = await this.primary.search(collectionName, queryVector, options);
    const primaryMs = Date.now() - started;

    if (this.shadowCompare) {
      // Fire and forget: the comparison must never delay or break the response.
      void this.compareShadow(collectionName, queryVector, options, results, primaryMs);
    }

    return results;
  }

  private async compareShadow(
    collectionName: string,
    queryVector: number[],
    options: { limit?: number; filter?: VectorPayload } | undefined,
    primaryResults: VectorSearchResult[],
    primaryMs: number,
  ): Promise<void> {
    try {
      const started = Date.now();
      const shadow = await this.secondary.search(collectionName, queryVector, options);
      const shadowMs = Date.now() - started;

      const primaryIds = new Set(primaryResults.map((r) => r.id));
      const shadowIds = new Set(shadow.map((r) => r.id));
      const intersection = [...primaryIds].filter((id) => shadowIds.has(id)).length;
      const overlap = primaryIds.size ? intersection / primaryIds.size : 1;

      const topScoreDelta =
        primaryResults[0] && shadow[0]
          ? Math.abs(primaryResults[0].score - shadow[0].score).toFixed(4)
          : 'n/a';

      const line =
        `shadow overlap=${overlap.toFixed(2)} ` +
        `(${intersection}/${primaryIds.size}) ` +
        `topScoreDelta=${topScoreDelta} ` +
        `${this.readFrom}=${primaryMs}ms ${this.secondaryName}=${shadowMs}ms`;

      if (overlap < 0.8) {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    } catch (error) {
      this.logger.error(
        `Shadow search against ${this.secondaryName} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}