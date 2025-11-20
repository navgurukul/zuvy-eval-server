import { Module } from '@nestjs/common';
import { AiAssessmentService } from './ai-assessment.service';
import { AiAssessmentController } from './ai-assessment.controller';
import { AuthModule } from 'src/auth/auth.module';
import { LlmModule } from 'src/llm/llm.module';
import { QuestionsByLlmModule } from 'src/questions-by-llm/questions-by-llm.module';
import { DbModule } from 'src/db/db.module';
import { StorageModule } from 'src/storage/storage.module';
import { AiAssessmentCrudService } from './ai-assessment.crud.service';

@Module({
  imports: [AuthModule, LlmModule, QuestionsByLlmModule, DbModule, StorageModule],
  controllers: [AiAssessmentController],
  providers: [AiAssessmentService, AiAssessmentCrudService],
})
export class AiAssessmentModule {}
