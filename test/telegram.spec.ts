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
const OPENROUTER_API_KEY = "test-openrouter-key";
const BOARD_ID = "54589c21-3357-4145-b26d-a086a3d4078f";
const PENDING_ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

const testEnv = {
	...env,
	TELEGRAM_BOT_TOKEN: BOT_TOKEN,
	TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
	SUPABASE_URL,
	SUPABASE_ANON_KEY: SUPABASE_KEY,
	OPENROUTER_API_KEY,
} as Env;

const START_KEYBOARD = {
	inline_keyboard: [
		[{ text: "Получить Boards", callback_data: "get_boards" }],
		[{ text: "Создание задач", callback_data: "create_tasks" }],
	],
};

const BOARDS = [
	{
		id: BOARD_ID,
		title: "boardtest1",
		description: "",
	},
	{
		id: "2d5196bd-7474-41f9-a13d-458043a71eb4",
		title: "newboard",
		description: "",
	},
];

const MEMBER_1 = {
	id: "7ed99ca8-7ac7-4f25-bc30-a9de1aef3719",
	name: "Person2",
	email: "pers2@mail.org",
	role: "member",
	teamRole: null,
	boardRole: "member",
};

const MEMBER_2 = {
	id: "afd4d08e-df47-4818-b2d9-bbe688ffadf2",
	name: "Person1",
	email: "pers1@mail.org",
	role: "member",
	teamRole: null,
	boardRole: "member",
};

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

function createCreateBoardCallbackUpdate(pendingId: string, boardIndex: number) {
	const compactPendingId = pendingId.replace(/-/g, "");
	return createCallbackUpdate(`c:${compactPendingId}:${boardIndex}`);
}

function mockSupabaseRpc(
	options: {
		boards?: typeof BOARDS;
		boardExists?: boolean;
		members?: typeof MEMBER_1[];
		pendingId?: string;
		pendingMessage?: string;
	} = {},
) {
	const boards = options.boards ?? BOARDS;
	const boardExists = options.boardExists ?? true;
	const members = options.members ?? [MEMBER_1, MEMBER_2];
	const pendingId = options.pendingId ?? PENDING_ID;
	const pendingMessage = options.pendingMessage ?? "Создать лендинг";

	return (url: string, init?: RequestInit) => {
		if (url.includes("/rest/v1/rpc/chat_list_boards")) {
			return new Response(JSON.stringify(boards), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_board_tasks")) {
			return new Response(
				JSON.stringify({
					board_title: "boardtest1",
					tasks: [
						{ id: "task-1", title: "Test Task Pers1", status: "backlog", priority: "low" },
						{ id: "task-2", title: "Test Task Pers2", status: "todo", priority: "medium" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/chat_telegram_start_create")) {
			return new Response(JSON.stringify(pendingId), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_telegram_save_pending_text")) {
			return new Response(JSON.stringify(pendingId), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_telegram_consume_pending")) {
			return new Response(
				JSON.stringify({
					id: pendingId,
					chatId: 42,
					messageText: pendingMessage,
					status: "awaiting_board",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/chat_board_exists")) {
			return new Response(JSON.stringify(boardExists), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_board_members")) {
			return new Response(JSON.stringify(members), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_create_tasks")) {
			const payload = JSON.parse(String(init?.body)) as {
				p_board_id: string;
				p_tasks: Array<{ title: string; assignee_id: string; position: number }>;
			};
			const memberById = new Map(members.map((member) => [member.id, member]));

			return new Response(
				JSON.stringify(
					payload.p_tasks.map((task, index) => {
						const assignee = memberById.get(task.assignee_id) ?? MEMBER_1;
						return {
							id: `task-${index + 1}`,
							title: task.title,
							boardId: payload.p_board_id,
							status: "backlog",
							priority: "medium",
							assignee: {
								id: assignee.id,
								name: assignee.name,
								email: assignee.email,
								role: assignee.role,
								teamRole: assignee.teamRole,
							},
						};
					}),
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		return null;
	};
}

describe("POST /telegram", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends greeting and inline buttons on /start", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 42,
				text: "Привет! Выберите действие:\n• Получить Boards — список досок и задач\n• Создание задач — разбить текст на подзадачи и сохранить на доску",
				reply_markup: START_KEYBOARD,
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
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			if (url.includes("/rest/v1/rpc/chat_telegram_save_pending_text")) {
				return new Response(JSON.stringify({ message: "No active pending request for chat" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createTelegramRequest(createMessageUpdate("hello"));
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
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			const rpcResponse = mockSupabaseRpc()(url, init);
			if (rpcResponse) {
				return rpcResponse;
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
						[{ text: "boardtest1", callback_data: `board:${BOARD_ID}` }],
						[
							{
								text: "newboard",
								callback_data: "board:2d5196bd-7474-41f9-a13d-458043a71eb4",
							},
						],
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
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			const rpcResponse = mockSupabaseRpc()(url, init);
			if (rpcResponse) {
				return rpcResponse;
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

		const request = createTelegramRequest(createBoardCallbackUpdate(BOARD_ID));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("starts create tasks flow when Создание задач is pressed", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			const rpcResponse = mockSupabaseRpc()(url, init);
			if (rpcResponse) {
				return rpcResponse;
			}

			if (url.endsWith("/answerCallbackQuery")) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 42,
				text: "Опишите задачу текстом — я разобью её на подзадачи и предложу выбрать доску для сохранения.",
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createCallbackUpdate("create_tasks"));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("shows board selection after task text is received", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			const rpcResponse = mockSupabaseRpc()(url, init);
			if (rpcResponse) {
				return rpcResponse;
			}

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 42,
				text: "Выберите доску, куда сохранить задачи:",
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: "boardtest1",
								callback_data: `c:${PENDING_ID.replace(/-/g, "")}:0`,
							},
						],
						[
							{
								text: "newboard",
								callback_data: `c:${PENDING_ID.replace(/-/g, "")}:1`,
							},
						],
					],
				},
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createMessageUpdate("Создать лендинг"));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("creates tasks after board is selected in create flow", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			if (url.includes("openrouter.ai")) {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: '[{"task":"task1"},{"task":"task2"}]' } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			const rpcResponse = mockSupabaseRpc()(url, init);
			if (rpcResponse) {
				return rpcResponse;
			}

			if (url.endsWith("/answerCallbackQuery")) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			const body = JSON.parse(String(init?.body)) as { text: string };
			expect(body.text).toContain("Создано 2 задач на доске «boardtest1»");
			expect(body.text).toContain("task1 → Person2");
			expect(body.text).toContain("task2 → Person1");

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createCreateBoardCallbackUpdate(PENDING_ID, 0));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalled();
	});

	it("notifies user when pending request is expired", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			if (url.includes("/rest/v1/rpc/chat_telegram_consume_pending")) {
				return new Response(JSON.stringify(null), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			const rpcResponse = mockSupabaseRpc()(url, init);
			if (rpcResponse) {
				return rpcResponse;
			}

			if (url.endsWith("/answerCallbackQuery")) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(JSON.parse(String(init?.body))).toMatchObject({
				chat_id: 42,
				text: "Запрос устарел или уже использован. Нажмите «Создание задач» снова.",
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createTelegramRequest(createCreateBoardCallbackUpdate(PENDING_ID, 0));
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
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
