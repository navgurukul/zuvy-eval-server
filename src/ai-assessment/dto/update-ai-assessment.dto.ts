import { PartialType } from '@nestjs/swagger';
import { CreateAiAssessmentDto } from './create-ai-assessment.dto';

export class UpdateAiAssessmentDto extends PartialType(CreateAiAssessmentDto) {}
