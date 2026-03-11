import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiAssessmentModule } from './ai-assessment/ai-assessment.module';
import { LlmModule } from './llm/llm.module';
import { LevelModule } from './level/level.module';
import { QuestionsByLlmModule } from './questions-by-llm/questions-by-llm.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { StorageModule } from './storage/storage.module';
import { BullModule } from '@nestjs/bullmq';
import { QuestionsModule } from './questions/questions.module';
import { VectorModule } from './vector/vector.module';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationzModule } from './notificationz/notificationz.module';

@Module({
  imports: [
    ConfigModule.forRoot(
      {
        isGlobal: true,
      }
    ),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT)
      }
    }),
    AiAssessmentModule, 
    LlmModule, 
    LevelModule, 
    QuestionsByLlmModule, 
    AuthModule,
    DbModule,
    StorageModule,
    QuestionsModule,
    VectorModule,
    NotificationzModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
