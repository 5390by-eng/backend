import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const WEBHOOK_SECRET = "test-webhook-secret";
const BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz";

const testEnv = {
	...env,
	TELEGRAM_BOT_TOKEN: BOT_TOKEN,
	TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as Env;

function createTelegramRequest(
	body: unknown,
	options: { secret?: string | null; method?: string } = {},
): Request {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (options.secret !== null) {
		headers["X-Telegram-Bot-Api-Secret-Token"] = options.secret ?? WEBHOOK_SECRET;
	}

	return new IncomingRequest("http://example.com/telegram", {
		method: options.method ?? "POST",
		headers,
		body: JSON.stringify(body),
	});
}

function createMessageUpdate(text = "hello") {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			chat: { id: 42 },
			text,
		},
	};
}

describe("POST /telegram", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends ok reply for incoming message", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 42,
				text: "ok",
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createMessageUpdate());
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns 401 when webhook secret is missing", async () => {
		const request = createTelegramRequest(createMessageUpdate(), { secret: null });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 401 when webhook secret is invalid", async () => {
		const request = createTelegramRequest(createMessageUpdate(), { secret: "wrong-secret" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 400 for invalid JSON body", async () => {
		const request = new IncomingRequest("http://example.com/telegram", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
			},
			body: "{not-json",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid JSON body" });
	});

	it("returns 405 for non-POST requests", async () => {
		const request = new IncomingRequest("http://example.com/telegram", {
			method: "GET",
			headers: {
				"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({ error: "Method not allowed" });
	});

	it("returns 500 when TELEGRAM_BOT_TOKEN is not configured", async () => {
		const request = createTelegramRequest(createMessageUpdate());
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				...env,
				TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "TELEGRAM_BOT_TOKEN is not configured" });
	});

	it("returns 500 when TELEGRAM_WEBHOOK_SECRET is not configured", async () => {
		const request = createTelegramRequest(createMessageUpdate());
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				...env,
				TELEGRAM_BOT_TOKEN: BOT_TOKEN,
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "TELEGRAM_WEBHOOK_SECRET is not configured" });
	});

	it("returns 200 without calling Telegram for updates without message", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		const request = createTelegramRequest({ update_id: 2, edited_message: { chat: { id: 42 } } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns 502 when Telegram API returns an error", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createMessageUpdate());
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Bad Request: chat not found" });
	});
});
