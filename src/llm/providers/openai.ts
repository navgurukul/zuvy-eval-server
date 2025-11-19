import { OpenAI } from 'openai';
import { LLMProvider, LLMResponse } from '../interface';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_KEY,
      timeout: 30000,
      maxRetries: 0, // We handle retries ourselves
    });
  }

  async completion(prompt: string): Promise<LLMResponse> {
    const start = Date.now();
    
    const res = await this.client.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });

    const text = res.choices[0]?.message?.content;
    if (!text) {
      throw new Error('Empty response from OpenAI');
    }

    return {
      text,
      usage: res.usage,
      latencyMs: Date.now() - start,
    };
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