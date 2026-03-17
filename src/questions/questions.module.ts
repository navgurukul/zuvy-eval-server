import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QuestionsService } from './questions.service';
import { QuestionsCrudService } from './questions.crud.service';
import { QuestionsController } from './questions.controller';
import { QuestionsProcessor } from './questions.processor';
import { QuestionIndexOutboxProcessor } from './question-index-outbox.processor';
import { QuestionIndexProcessor } from './question-index.processor';
import { QuestionIndexOutboxScheduler } from './question-index-outbox.scheduler';
import { LlmModule } from 'src/llm/llm.module';
import { QuestionsByLlmModule } from 'src/questions-by-llm/questions-by-llm.module';
import { VectorModule } from 'src/vector/vector.module';
import { DbModule } from 'src/db/db.module';
import { NotificationzModule } from 'src/notificationz/notificationz.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'llm-generation' },
      { name: 'question-index-outbox' },
      { name: 'question-index' },
    ),
    LlmModule,
    QuestionsByLlmModule,
    VectorModule,
    DbModule,
    NotificationzModule,
  ],
  controllers: [QuestionsController],
  providers: [
    QuestionsService,
    QuestionsCrudService,
    QuestionsProcessor,
    QuestionIndexOutboxProcessor,
    QuestionIndexProcessor,
    QuestionIndexOutboxScheduler,
  ],
})
export class QuestionsModule {}
