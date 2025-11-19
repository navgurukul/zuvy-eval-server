import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMResponse, LLMProvider } from '../interface';

export class GenAIProvider implements LLMProvider {
  private client: GoogleGenerativeAI;

  constructor() {
    this.client = new GoogleGenerativeAI(
      process.env.GOOGLE_GENAI_API_KEY!
    );
  }

  async completion(prompt: string): Promise<LLMResponse> {
    const start = Date.now();
    const model = this.client.getGenerativeModel({ 
      model: 'gemini-pro',
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