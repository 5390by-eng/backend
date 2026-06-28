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
const SUPABASE_URL = "https://example.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test";

const testEnv = {
	...env,
	TELEGRAM_BOT_TOKEN: BOT_TOKEN,
	TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
	SUPABASE_URL,
	SUPABASE_ANON_KEY: SUPABASE_KEY,
} as Env;

const GET_BOARDS_INLINE_KEYBOARD = {
	inline_keyboard: [[{ text: "Получить Boards", callback_data: "get_boards" }]],
};

const BOARDS_KEYBOARD = GET_BOARDS_INLINE_KEYBOARD;

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

function createCallbackUpdate(data: string) {
	return {
		update_id: 3,
		callback_query: {
			id: "callback-2",
			data,
			message: {
				message_id: 12,
				chat: { id: 42 },
			},
		},
	};
}

function createBoardCallbackUpdate(boardId: string) {
	return createCallbackUpdate(`board:${boardId}`);
}

describe("POST /telegram", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends greeting and inline button on /start", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 42,
				text: "Привет! Нажмите кнопку ниже, чтобы получить список досок.",
				reply_markup: BOARDS_KEYBOARD,
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createMessageUpdate("/start"));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("ignores unrelated messages without calling Telegram", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		const request = createTelegramRequest(createMessageUpdate("hello"));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).not.toHaveBeenCalled();
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
		const request = createTelegramRequest(createMessageUpdate("/start"));
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
		const request = createTelegramRequest(createMessageUpdate("/start"));
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

	it("shows board selection buttons when Получить Boards is pressed", async () => {
		const boards = [
			{
				id: "54589c21-3357-4145-b26d-a086a3d4078f",
				title: "boardtest1",
				description: "",
			},
			{
				id: "2d5196bd-7474-41f9-a13d-458043a71eb4",
				title: "newboard",
				description: "",
			},
		];

		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			if (url.includes("/rest/v1/rpc/chat_list_boards")) {
				return new Response(JSON.stringify(boards), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url.endsWith("/answerCallbackQuery")) {
				expect(JSON.parse(String(init?.body))).toEqual({ callback_query_id: "callback-2" });
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 42,
				text: "Выберите доску:",
				reply_markup: {
					inline_keyboard: [
						[{ text: "boardtest1", callback_data: "board:54589c21-3357-4145-b26d-a086a3d4078f" }],
						[{ text: "newboard", callback_data: "board:2d5196bd-7474-41f9-a13d-458043a71eb4" }],
					],
				},
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createCallbackUpdate("get_boards"));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("sends tasks list when board button is pressed", async () => {
		const boardId = "54589c21-3357-4145-b26d-a086a3d4078f";
		const tasksPayload = {
			board_title: "boardtest1",
			tasks: [
				{ id: "task-1", title: "Test Task Pers1", status: "backlog", priority: "low" },
				{ id: "task-2", title: "Test Task Pers2", status: "todo", priority: "medium" },
			],
		};

		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			if (url.includes("/rest/v1/rpc/chat_board_tasks")) {
				expect(JSON.parse(String(init?.body))).toEqual({ p_board_id: boardId });
				return new Response(JSON.stringify(tasksPayload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url.endsWith("/answerCallbackQuery")) {
				expect(JSON.parse(String(init?.body))).toEqual({ callback_query_id: "callback-2" });
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 42,
				text: "Задачи на доске «boardtest1»:\n\n1. Test Task Pers1 (backlog)\n\n2. Test Task Pers2 (todo)",
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createBoardCallbackUpdate(boardId));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("returns 502 when Telegram API returns an error", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createMessageUpdate("/start"));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Bad Request: chat not found" });
	});
});
