import { Test, TestingModule } from '@nestjs/testing';
import { QuestionsByLlmService } from './questions-by-llm.service';

describe('QuestionsByLlmService', () => {
  let service: QuestionsByLlmService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [QuestionsByLlmService],
    }).compile();

    service = module.get<QuestionsByLlmService>(QuestionsByLlmService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
