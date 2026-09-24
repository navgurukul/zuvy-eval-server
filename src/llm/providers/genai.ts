import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMResponse, LLMProvider } from '../interface';

/**
 * "gemini-pro" was retired and 404s; it was never noticed because the fallback
 * was unreachable. Overridable so a future retirement is an env change.
 */
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export class GenAIProvider implements LLMProvider {
  private client: GoogleGenerativeAI;
  private readonly modelName: string;

  constructor() {
    this.client = new GoogleGenerativeAI(
      process.env.GOOGLE_GENAI_API_KEY!
    );
    this.modelName = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  }

  async completion(prompt: string): Promise<LLMResponse> {
    const start = Date.now();
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      // Match the primary provider, so failing over does not silently change
      // how deterministic generation is.
      generationConfig: { temperature: 0.3 },
    });
    
    const res = await model.generateContent(prompt);
    const text = res.response.text();
    
    if (!text) {
      throw new Error('Empty response from GenAI');
    }

    return {
      text,
      usage: null,
      latencyMs: Date.now() - start,
    };
  }
}