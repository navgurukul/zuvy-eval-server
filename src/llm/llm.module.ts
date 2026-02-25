import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';
import { DbModule } from 'src/db/db.module';
import { LLMUsageService } from './llmUsage.service';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    DbModule,
    BullModule.registerQueue({
      name: 'llm-generation'
    })
  ],
  controllers: [LlmController],
  providers: [LlmService, LLMUsageService],
  exports: [LlmService, LLMUsageService],
})
export class LlmModule {}
