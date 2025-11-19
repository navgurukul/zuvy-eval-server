import { Test, TestingModule } from '@nestjs/testing';
import { AiAssessmentService } from './ai-assessment.service';

describe('AiAssessmentService', () => {
  let service: AiAssessmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AiAssessmentService],
    }).compile();

    service = module.get<AiAssessmentService>(AiAssessmentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
