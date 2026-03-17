import { Module } from '@nestjs/common';
import { AiAssessmentService } from './ai-assessment.service';
import { AiAssessmentController } from './ai-assessment.controller';
import { AuthModule } from 'src/auth/auth.module';
import { LlmModule } from 'src/llm/llm.module';
import { QuestionsByLlmModule } from 'src/questions-by-llm/questions-by-llm.module';
import { DbModule } from 'src/db/db.module';
import { StorageModule } from 'src/storage/storage.module';
import { VectorModule } from 'src/vector/vector.module';
import { EmbeddingsService } from 'src/llm/embeddings.service';
import { AiAssessmentMappingService } from './ai-assessment.mapping.service';
import { AiAssessmentCrudService } from './ai-assessment.crud.service';

@Module({
  imports: [
    AuthModule,
    LlmModule,
    QuestionsByLlmModule,
    DbModule,
    StorageModule,
    VectorModule,
  ],
  controllers: [AiAssessmentController],
  providers: [
    AiAssessmentService,
    AiAssessmentCrudService,
    EmbeddingsService,
    AiAssessmentMappingService,
  ],
})
export class AiAssessmentModule {}
