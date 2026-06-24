import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const testEnv = {
	...env,
	OPENROUTER_API_KEY: "test-api-key",
} as Env;

function createChatRequest(body: unknown): Request {
	return new IncomingRequest("http://example.com/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/chat", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns task array on valid request", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: '[{"task":"task1"},{"task":"task2"}]',
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const request = createChatRequest({ message: "Создать лендинг" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([{ task: "task1" }, { task: "task2" }]);
	});

	it("returns 400 when message is empty", async () => {
		const request = createChatRequest({ message: "   " });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Field 'message' is required and must be a non-empty string",
		});
	});

	it("returns 400 when message is missing", async () => {
		const request = createChatRequest({});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});

	it("returns 502 when model returns invalid task format", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "not valid json array" } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const request = createChatRequest({ message: "Создать лендинг" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Invalid task decomposition format from model",
		});
	});

	it("returns 502 when OpenRouter returns an error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const request = createChatRequest({ message: "Привет" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "Rate limit exceeded" });
	});

	it("returns 500 when OPENROUTER_API_KEY is not configured", async () => {
		const request = createChatRequest({ message: "Привет" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env } as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "OPENROUTER_API_KEY is not configured" });
	});
});
