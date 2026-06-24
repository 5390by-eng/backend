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

describe("CORS /api/chat", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns 204 with CORS headers on OPTIONS preflight", async () => {
		const request = new IncomingRequest("http://example.com/api/chat", {
			method: "OPTIONS",
			headers: {
				Origin: "http://localhost:5173",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "Content-Type",
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
		expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
		expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
	});

	it("adds CORS headers to POST response for allowed origin", async () => {
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

		const request = new IncomingRequest("http://example.com/api/chat", {
			method: "POST",
			headers: {
				Origin: "http://localhost:5173",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ message: "Привет" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
		expect(await response.json()).toEqual([{ task: "task1" }, { task: "task2" }]);
	});

	it("does not add CORS headers for disallowed origin", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: '[{"task":"task1"}]',
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const request = new IncomingRequest("http://example.com/api/chat", {
			method: "POST",
			headers: {
				Origin: "http://evil.example.com",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ message: "Привет" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("returns 403 on OPTIONS for disallowed origin", async () => {
		const request = new IncomingRequest("http://example.com/api/chat", {
			method: "OPTIONS",
			headers: {
				Origin: "http://evil.example.com",
				"Access-Control-Request-Method": "POST",
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});
