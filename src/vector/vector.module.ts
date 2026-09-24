import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { VectorService } from './vector.service';
import { VectorController } from './vector.controller';
import { VECTOR_STORE } from './constants';
import type { IVectorStore } from './interfaces/vector-store.interface';
import {
  DualWriteVectorStore,
  OpenSearchVectorStore,
  PineconeVectorStore,
  QdrantVectorStore,
} from './strategies';

/**
 * Picks the vector store from VECTOR_DB at bootstrap:
 *
 *   qdrant      (default) Qdrant only
 *   opensearch  Amazon OpenSearch Serverless only
 *   dual        write to both, read from VECTOR_READ_FROM
 *   pinecone    stub, not implemented
 *
 * The stores are constructed inside this factory rather than registered as
 * providers, so an unselected store is never instantiated. That matters:
 * OpenSearchVectorStore throws from its constructor when OPENSEARCH_HOST is
 * unset, which would otherwise break every Qdrant-only deployment at boot.
 */
function createVectorStore(config: ConfigService): IVectorStore {
  const logger = new Logger('VectorModule');
  const vectorDb = (
    config.get<string>('VECTOR_DB') ||
    process.env.VECTOR_DB ||
    'qdrant'
  )
    .trim()
    .toLowerCase();

  switch (vectorDb) {
    case 'opensearch':
      logger.log('VECTOR_DB=opensearch -> OpenSearchVectorStore');
      return new OpenSearchVectorStore(config);

    case 'dual':
      logger.log(
        'VECTOR_DB=dual -> DualWriteVectorStore (Qdrant + OpenSearch)',
      );
      return new DualWriteVectorStore(
        config,
        new QdrantVectorStore(config),
        new OpenSearchVectorStore(config),
      );

    case 'pinecone':
      logger.log('VECTOR_DB=pinecone -> PineconeVectorStore');
      return new PineconeVectorStore();

    case 'qdrant':
      logger.log('VECTOR_DB=qdrant -> QdrantVectorStore');
      return new QdrantVectorStore(config);

    default:
      logger.warn(
        `Unrecognised VECTOR_DB="${vectorDb}"; falling back to QdrantVectorStore. ` +
          `Valid values: qdrant, opensearch, dual, pinecone.`,
      );
      return new QdrantVectorStore(config);
  }
}

@Module({
  imports: [ConfigModule],
  controllers: [VectorController],
  providers: [
    {
      provide: VECTOR_STORE,
      inject: [ConfigService],
      useFactory: createVectorStore,
    },
    VectorService,
  ],
  exports: [VectorService, VECTOR_STORE],
})
export class VectorModule {}
