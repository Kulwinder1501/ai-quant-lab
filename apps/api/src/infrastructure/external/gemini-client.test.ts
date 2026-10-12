import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiApiError, GeminiClient, geminiClientFromEnvironment } from "./gemini-client.js";

afterEach(() => { vi.restoreAllMocks(); });

const KEY = "test-secret-key-123";

function okResponse(text: string, extra: Record<string, unknown> = {}) {
  return { data: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 }, ...extra } };
}

describe("GeminiClient", () => {
  it("sends the key in a header, never the URL, pins temperature to 0 and requests JSON", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue(okResponse('{"ok":true}'));
    const result = await new GeminiClient({ apiKey: KEY, model: "some-model" }).completeJson({ system: "sys", user: "usr" });

    const [url, body, config] = post.mock.calls[0]! as [string, any, any];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/some-model:generateContent");
    expect(url).not.toContain(KEY);
    expect(config.headers["x-goog-api-key"]).toBe(KEY);
    expect(body.generationConfig).toEqual({ temperature: 0, responseMimeType: "application/json" });
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.contents[0].parts[0].text).toBe("usr");
    expect(result).toEqual({ text: '{"ok":true}', model: "some-model", finishReason: "STOP", promptTokens: 12, outputTokens: 34 });
  });

  it("joins multi-part text", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] } });
    expect((await new GeminiClient({ apiKey: KEY, model: "m" }).completeJson({ system: "s", user: "u" })).text).toBe("ab");
  });

  it("surfaces a blocked prompt and an empty answer as errors", async () => {
    vi.spyOn(axios, "post").mockResolvedValueOnce({ data: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(new GeminiClient({ apiKey: KEY, model: "m" }).completeJson({ system: "s", user: "u" })).rejects.toThrow(/blocked the prompt \(SAFETY\)/);
    vi.spyOn(axios, "post").mockResolvedValueOnce({ data: { candidates: [{ finishReason: "MAX_TOKENS" }] } });
    await expect(new GeminiClient({ apiKey: KEY, model: "m" }).completeJson({ system: "s", user: "u" })).rejects.toThrow(/no text \(finishReason MAX_TOKENS\)/);
  });

  it("never leaks the key through a failed request's error message", async () => {
    const failure = Object.assign(new Error(`Request failed, config: ${KEY}`), { isAxiosError: true, response: { status: 429 }, config: { headers: { "x-goog-api-key": KEY } } });
    vi.spyOn(axios, "post").mockRejectedValue(failure);
    vi.spyOn(axios, "isAxiosError").mockReturnValue(true);
    const error = await new GeminiClient({ apiKey: KEY, model: "m" }).completeJson({ system: "s", user: "u" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiApiError);
    expect(String((error as Error).message)).toBe("Gemini request failed (429).");
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it("requires a key and an explicit model", () => {
    expect(() => new GeminiClient({ apiKey: " ", model: "m" })).toThrow(/API key/);
    expect(() => new GeminiClient({ apiKey: KEY, model: "" })).toThrow(/model/);
  });
});

describe("geminiClientFromEnvironment", () => {
  it("is null unless both the key and the model are set", () => {
    expect(geminiClientFromEnvironment({})).toBeNull();
    expect(geminiClientFromEnvironment({ GEMINI_API_KEY: KEY })).toBeNull();
    expect(geminiClientFromEnvironment({ GEMINI_MODEL: "m" })).toBeNull();
    expect(geminiClientFromEnvironment({ GEMINI_API_KEY: KEY, GEMINI_MODEL: "m" })?.model).toBe("m");
  });
});
