import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { OpenAIProvider } from './providers/openai';
import { GenAIProvider } from './providers/genai';
import { CircuitBreaker } from './utils/circuit-breaker';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private primary: OpenAIProvider;
  private fallback: GenAIProvider;
  private primaryBreaker: CircuitBreaker;
  private fallbackBreaker: CircuitBreaker;

  constructor() {
    this.primary = new OpenAIProvider();
    this.fallback = new GenAIProvider();

    // Circuit breaker: 5 failures in 60s = open for 30s
    this.primaryBreaker = new CircuitBreaker('OpenAI', {
      failureThreshold: 5,
      resetTimeout: 30000,
      monitorWindow: 60000,
    });

    this.fallbackBreaker = new CircuitBreaker('GenAI', {
      failureThreshold: 3,
      resetTimeout: 45000,
      monitorWindow: 60000,
    });
  }

  async generateCompletion(prompt: string) {
    try {
      if (!this.primaryBreaker.isOpen()) {
        try {
          const result = await this.executeWithRetry(
            () => this.primary.completion(prompt),
            'primary'
          );
          this.primaryBreaker.recordSuccess();
          return { ...result, provider: 'openai' };
        } catch (error) {
          this.primaryBreaker.recordFailure();
          this.logger.warn(`Primary provider failed: ${error.message}`);
        }
      } else {
        this.logger.warn('Primary circuit breaker is OPEN, skipping to fallback');
      }

      if (!this.fallbackBreaker.isOpen()) {
        try {
          const result = await this.executeWithRetry(
            () => this.fallback.completion(prompt),
            'fallback'
          );
          this.fallbackBreaker.recordSuccess();
          return { ...result, provider: 'genai' };
        } catch (error) {
          this.fallbackBreaker.recordFailure();
          this.logger.error(`Fallback provider failed: ${error.message}`);
          throw new Error('All LLM providers are unavailable');
        }
      }

      throw new Error('All providers circuit breakers are open');
    } catch (error) {
      this.logger.error("Error generating response from llm: ", error);
    }
  }

  private async executeWithRetry(
    fn: () => Promise<any>,
    providerType: 'primary' | 'fallback'
  ) {
    const maxRetries = providerType === 'primary' ? 2 : 1;
    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries && this.isRetryable(error)) {
          const delay = this.getBackoffDelay(attempt);
          this.logger.debug(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await this.sleep(delay);
        }
        throw lastError;
      }
    }
  }

  private isRetryable(error: any): boolean {
    const retryableStatuses = [408, 429, 421, 500, 502, 503, 504];
    return !error.status || retryableStatuses.includes(error.status);
  }

  private getBackoffDelay(attempt: number): number {
    const baseDelay = 1000 * Math.pow(2, attempt);
    const jitter = Math.random() * 500;
    return Math.min(baseDelay + jitter, 5000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async generateAudioSummary(
  text: string,
  language: string,
  ) {
    try {
      const audioBuffer = await this.primary.generateSpeech(text, language);

      return audioBuffer;
    } catch (error) {
      this.logger.error(
        `Audio generation failed`,
        error.stack,
      );

      throw new InternalServerErrorException(
        'Failed to generate audio. Please try again later.',
      );
    }
  }
}
