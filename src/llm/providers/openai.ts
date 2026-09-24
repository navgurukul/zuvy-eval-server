import { OpenAI } from 'openai';
import { LLMProvider, LLMResponse } from '../interface';
import { Logger } from '@nestjs/common';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private readonly logger = new Logger(OpenAIProvider.name);
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_KEY,
      timeout: 240000,
      maxRetries: 0, // We handle retries ourselves
    });
  }

  async completion(prompt: string): Promise<LLMResponse> {
    try {
      const start = Date.now();
      const res = await this.client.responses.create({
        model: 'gpt-4.1',
        input: prompt,
        temperature: 0.3,
        top_p: 0.9,
      });
      const text = res.output_text;
      if (!text) {
        throw new Error('Empty response from OpenAI');
      }
      return {
        text,
        usage: res.usage,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      // Propagate. Returning an empty-text "success" here used to hide every
      // OpenAI failure from LlmService: the circuit breaker recorded a success,
      // never opened, and the Gemini fallback was therefore unreachable code.
      this.logger.error('Error generating openai response.', error);
      throw error;
    }
  }

  async generateSpeech(inputText: string, language = "hi") {
    const voices = {
      en: "coral",
      hi: "coral",
      kn: "alloy",
      mr: "verse",
    };

    const enhanced = `${inputText}. Add a small fresh extension in the same context.`;

    const mp3 = await this.client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voices[language] || voices.hi,
      input: enhanced,
      instructions: `Speak naturally in ${language} with a warm and friendly tone.`,
    });

    return Buffer.from(await mp3.arrayBuffer());
  }
}