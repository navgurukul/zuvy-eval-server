import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';
import { DbModule } from 'src/db/db.module';
import { LLMUsageService } from './llmUsage.service';

@Module({
  imports: [DbModule],
  controllers: [LlmController],
  providers: [LlmService, LLMUsageService],
  exports: [LlmService, LLMUsageService],
})
export class LlmModule {}
