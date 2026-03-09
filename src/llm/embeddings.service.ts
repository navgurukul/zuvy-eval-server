import { Injectable, Logger } from '@nestjs/common';
import { OpenAI } from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';

@Injectable()
export class EmbeddingsService {
  private readonly client: OpenAI;
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor() {
    const apiKey = process.env.OPENAI_KEY;
    if (!apiKey) {
      this.logger.warn('OPENAI_KEY not set; embeddings will fail at runtime.');
    }
    this.client = new OpenAI({
      apiKey,
      timeout: 60_000,
    });
  }

  async embed(text: string): Promise<number[]> {
    if (!text?.trim()) {
      throw new Error('Text is required for embedding');
    }
    const res = await this.client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.trim(),
      encoding_format: 'float',
    });
    const embedding = res.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('OpenAI returned no embedding');
    }
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    try {
      const trimmed = texts.map((t) => (t ?? '').trim()).filter(Boolean);
      if (trimmed.length === 0) {
        return [];
      }
      const res = await this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: trimmed,
        encoding_format: 'float',
      });
      const byIndex = (res.data ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return byIndex.map((d) => d.embedding ?? []);
    } catch (error) {
      this.logger.error('Error embedding texts:', error);
      throw error;
    }
  }

  get dimension(): number {
    return 1536;
  }
}
