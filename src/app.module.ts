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

@Module({
  imports: [
    ConfigModule.forRoot(
      {
        isGlobal: true,
      }
    ),
    AiAssessmentModule, 
    LlmModule, 
    LevelModule, 
    QuestionsByLlmModule, 
    AuthModule,
    DbModule,
    StorageModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
