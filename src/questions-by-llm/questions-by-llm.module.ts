import { Module } from '@nestjs/common';
import { QuestionsByLlmService } from './questions-by-llm.service';
import { QuestionsByLlmController } from './questions-by-llm.controller';
import { QuestionEvaluationService } from './question-evaluation.service';
import { QuestionsEvaluationController } from './question-evaluation.controller';
import { DbModule } from 'src/db/db.module';

@Module({
  imports: [DbModule],
  controllers: [QuestionsByLlmController, QuestionsEvaluationController],
  providers: [QuestionsByLlmService, QuestionEvaluationService],
  exports: [QuestionEvaluationService, QuestionsByLlmService],
})
export class QuestionsByLlmModule {}
