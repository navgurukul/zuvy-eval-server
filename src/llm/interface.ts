export interface LLMProvider {
  completion(prompt: string, options?: any): Promise<{
    text: string | null;
    usage?: any;
    latencyMs: number;
  }>;
}

export interface LLMResponse {
  text: string;
  usage: any;
  latencyMs: number;
}