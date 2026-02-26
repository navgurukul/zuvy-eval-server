import { Injectable, Logger } from '@nestjs/common';
import {
  IVectorStore,
  VectorPoint,
  VectorSearchResult,
} from '../interfaces/vector-store.interface';

/**
 * Stub implementation for Pinecone. Swap to this provider in VectorModule
 * and add the Pinecone SDK to implement the methods when needed.
 *
 * To use: npm install @pinecone-database/pinecone
 * Then implement using PineconeClient and index.upsert / index.query.
 */
@Injectable()
export class PineconeVectorStore implements IVectorStore {
  private readonly logger = new Logger(PineconeVectorStore.name);

  async ensureCollection(
    _collectionName: string,
    _vectorSize: number,
  ): Promise<void> {
    this.logger.warn('PineconeVectorStore: ensureCollection not implemented');
    // Pinecone uses indexes; create index if not exists
  }

  async upsert(_collectionName: string, _points: VectorPoint[]): Promise<void> {
    throw new Error(
      'PineconeVectorStore not implemented. Use Qdrant by setting VECTOR_DB=qdrant or implement PineconeVectorStore.',
    );
  }

  async search(
    _collectionName: string,
    _queryVector: number[],
    _options?: { limit?: number; filter?: import('../interfaces/vector-store.interface').VectorPayload },
  ): Promise<VectorSearchResult[]> {
    throw new Error(
      'PineconeVectorStore not implemented. Use Qdrant by setting VECTOR_DB=qdrant or implement PineconeVectorStore.',
    );
  }

  async delete(_collectionName: string, _ids: string[]): Promise<void> {
    throw new Error(
      'PineconeVectorStore not implemented. Use Qdrant by setting VECTOR_DB=qdrant or implement PineconeVectorStore.',
    );
  }
}
