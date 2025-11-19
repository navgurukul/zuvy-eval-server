import { Test, TestingModule } from '@nestjs/testing';
import { QuestionsByLlmController } from './questions-by-llm.controller';
import { QuestionsByLlmService } from './questions-by-llm.service';

describe('QuestionsByLlmController', () => {
  let controller: QuestionsByLlmController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QuestionsByLlmController],
      providers: [QuestionsByLlmService],
    }).compile();

    controller = module.get<QuestionsByLlmController>(QuestionsByLlmController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
