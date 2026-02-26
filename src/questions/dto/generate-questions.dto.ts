import { IsObject, IsOptional, IsNumber, Min } from 'class-validator';

/**
 * Payload for question generation.
 * topics: map of topic name -> number of questions to generate for that topic.
 * Example: { "arrays": 20, "strings": 15 } => 2 jobs for arrays (10+10), 2 for strings (10+5).
 */
export class GenerateQuestionsDto {
  /**
   * Topic name -> count of questions to generate.
   * Each topic gets ceil(count/10) jobs, each job generating at most 10 questions.
   */
  @IsObject()
  topics: Record<string, number>;

  @IsOptional()
  @IsNumber()
  levelId?: number | null;
}

/** Single job payload: one topic, one batch of at most 10 questions. */
export interface GenerateTopicBatchJobPayload {
  topic: string;
  count: number;
  levelId?: number | null;
}
