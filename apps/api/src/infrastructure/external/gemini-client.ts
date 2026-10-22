import axios from "axios";

export class GeminiApiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "GeminiApiError";
  }
}

export interface LlmCompletion {
  /** The model's raw text, exactly as returned. Parsing and validation are the caller's job. */
  text: string;
  model: string;
  finishReason: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
}

export interface LlmClient {
  readonly model: string;
  completeJson(input: { system: string; user: string }): Promise<LlmCompletion>;
}

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  baseUrl?: string;
}

/**
 * Minimal Gemini `generateContent` client for JSON-mode completions.
 *
 * Temperature is pinned to 0 so a repeat of the same prompt is as close to reproducible as the
 * service allows. The key travels in a header, never in the URL, so it cannot end up in a request
 * log. There is no model default on purpose: model ids change, and a stale default would silently
 * score a different model than the one the operator believes is running.
 */
export class GeminiClient implements LlmClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: GeminiClientOptions) {
    if (!options.apiKey.trim()) throw new Error("GeminiClient needs a non-empty API key.");
    if (!options.model.trim()) throw new Error("GeminiClient needs an explicit model id.");
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    // 60 s: a successful pre-market call returns in about 15-25 s, so this leaves room without letting a hung request
    // hold a slot (the 2026-10-16 "no response" failures each ran out the previous 45 s).
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async completeJson(input: { system: string; user: string }): Promise<LlmCompletion> {
    let response;
    try {
      response = await axios.post(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: "user", parts: [{ text: input.user }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        },
        { headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" }, timeout: this.timeoutMs },
      );
    } catch (error) {
      // The axios error can embed request headers; report the status only, never the config.
      const status = axios.isAxiosError(error) ? error.response?.status ?? "no response" : "unknown";
      throw new GeminiApiError(`Gemini request failed (${String(status)}).`);
    }

    const data = response.data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (data.promptFeedback?.blockReason) {
      throw new GeminiApiError(`Gemini blocked the prompt (${data.promptFeedback.blockReason}).`);
    }
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!text.trim()) throw new GeminiApiError(`Gemini returned no text (finishReason ${candidate?.finishReason ?? "none"}).`);

    return {
      text,
      model: this.model,
      finishReason: candidate?.finishReason ?? null,
      promptTokens: data.usageMetadata?.promptTokenCount ?? null,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
}

/** Builds the client from env, or null when the operator has not configured one. */
export function geminiClientFromEnvironment(env: NodeJS.ProcessEnv = process.env): GeminiClient | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim();
  if (!apiKey || !model) return null;
  return new GeminiClient({ apiKey, model });
}
