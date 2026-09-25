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

  /**
   * Shape returned when no provider could serve the request. Callers read
   * .text, so returning undefined here would throw at several call sites, two
   * of them inside database transactions. Empty text keeps their existing
   * behaviour; "failed" lets a caller tell a real empty answer from an outage.
   */
  private failedCompletion() {
    return { text: '', usage: null, latencyMs: 0, provider: null, failed: true };
  }

  /**
   * One attempt at one provider, with that provider's breaker and retry policy.
   * Returns null when it could not serve the request, so the caller can move on
   * to the next provider in its order.
   */
  private async tryProvider(which: 'openai' | 'genai', prompt: string) {
    const isPrimary = which === 'openai';
    const breaker = isPrimary ? this.primaryBreaker : this.fallbackBreaker;
    const provider = isPrimary ? this.primary : this.fallback;

    if (breaker.isOpen()) {
      this.logger.warn(`${which} circuit breaker is OPEN, skipping it`);
      return null;
    }

    try {
      const result = await this.executeWithRetry(
        () => provider.completion(prompt),
        isPrimary ? 'primary' : 'fallback',
      );
      breaker.recordSuccess();
      return { ...result, provider: which };
    } catch (error) {
      breaker.recordFailure();
      this.logger.warn(`${which} provider failed: ${error.message}`);
      return null;
    }
  }

  private async completionInOrder(
    order: Array<'openai' | 'genai'>,
    prompt: string,
  ) {
    for (const which of order) {
      const result = await this.tryProvider(which, prompt);
      if (result) return result;
    }
    this.logger.error(
      `All LLM providers are unavailable (tried: ${order.join(' then ')})`,
    );
    return this.failedCompletion();
  }

  async generateCompletion(prompt: string) {
    return this.completionInOrder(['openai', 'genai'], prompt);
  }

  /**
   * Same providers and same fallback behaviour, but tries the named one first.
   *
   * This exists so a check can run on a different model from the one whose
   * work it is checking. Asking the model that wrote a question to re-check it
   * shares its blind spots: a permutation question keyed 288 whose answer is
   * 144 is wrong because of one specific mistake (treating repeated letters as
   * distinguishable), and the model that made that mistake tends to make it
   * again. A different model family fails differently, which is the whole
   * value of a second opinion.
   *
   * Still falls back to the other provider, so preferring a model that is
   * unconfigured or down degrades to single-model checking rather than to no
   * checking at all.
   */
  async generateCompletionPreferring(
    preferred: 'openai' | 'genai',
    prompt: string,
  ) {
    const order: Array<'openai' | 'genai'> =
      preferred === 'genai' ? ['genai', 'openai'] : ['openai', 'genai'];
    return this.completionInOrder(order, prompt);
  }

  private async executeWithRetry(
    fn: () => Promise<any>,
    providerType: 'primary' | 'fallback'
  ) {
    const maxRetries = providerType === 'primary' ? 2 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // The throw used to sit here unconditionally, so the loop slept for the
        // backoff and then threw on the first failure: maxRetries never applied.
        const canRetry = attempt < maxRetries && this.isRetryable(error);
        if (!canRetry) throw lastError;

        const delay = this.getBackoffDelay(attempt);
        this.logger.debug(
          `${providerType} retry ${attempt + 1}/${maxRetries} after ${delay}ms`,
        );
        await this.sleep(delay);
      }
    }

    throw lastError;
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
