import { Test, TestingModule } from '@nestjs/testing';
import { AiAssessmentController } from './ai-assessment.controller';
import { AiAssessmentService } from './ai-assessment.service';

describe('AiAssessmentController', () => {
  let controller: AiAssessmentController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiAssessmentController],
      providers: [AiAssessmentService],
    }).compile();

    controller = module.get<AiAssessmentController>(AiAssessmentController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
