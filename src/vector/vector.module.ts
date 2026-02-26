import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VectorService } from './vector.service';
import { VectorController } from './vector.controller';
import { VECTOR_STORE } from './constants';
import { QdrantVectorStore } from './strategies/qdrant.vector-store';
import { PineconeVectorStore } from './strategies/pinecone.vector-store';

const vectorDb = process.env.VECTOR_DB ?? 'qdrant';

@Module({
  imports: [ConfigModule],
  controllers: [VectorController],
  providers: [
    QdrantVectorStore,
    PineconeVectorStore,
    {
      provide: VECTOR_STORE,
      useClass: vectorDb === 'pinecone' ? PineconeVectorStore : QdrantVectorStore,
    },
    VectorService,
  ],
  exports: [VectorService, VECTOR_STORE],
})
export class VectorModule {}
