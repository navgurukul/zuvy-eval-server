import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QuestionsService } from './questions.service';
import { QuestionsController } from './questions.controller';
import { QuestionsProcessor } from './questions.processor';
import { LlmModule } from 'src/llm/llm.module';
import { QuestionsByLlmModule } from 'src/questions-by-llm/questions-by-llm.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'llm-generation' }),
    LlmModule,
    QuestionsByLlmModule,
  ],
  controllers: [QuestionsController],
  providers: [QuestionsService, QuestionsProcessor],
})
export class QuestionsModule {}
