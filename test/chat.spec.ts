import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const BOARD_ID = "4349e4fd-03df-4e56-8b29-b618dad9914f";
const USER_ID = "7ed99ca8-7ac7-4f25-bc30-a9de1aef3719";
const AUTH_TOKEN = "valid-token";
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

const testEnv = {
	...env,
	OPENROUTER_API_KEY: "test-api-key",
	SUPABASE_URL: "https://example.supabase.co",
	SUPABASE_ANON_KEY:
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test",
} as Env;

const testEnvWithTelegram = {
	...testEnv,
	TELEGRAM_BOT_TOKEN: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
} as Env;

function createChatRequest(body: unknown, options: { auth?: boolean } = {}): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (options.auth !== false) {
		headers.Authorization = `Bearer ${AUTH_TOKEN}`;
	}

	return new IncomingRequest("http://example.com/api/chat", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

function authUserResponse(): Response {
	return new Response(JSON.stringify({ id: USER_ID, email: "user@example.com" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function consumeAiSuccessResponse(): Response {
	return new Response(JSON.stringify({ consumed: true, source: "plan" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function resolveChatFetchUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function mockSupabaseRpc(
	options: {
		boardExists?: boolean;
		members?: typeof MEMBER_1[];
		subscribers?: Array<{ chat_id: number; username: string }>;
		consumeAiRequest?: "success" | "quota_exceeded";
	} = {},
) {
	const members = options.members ?? [MEMBER_1, MEMBER_2];
	const boardExists = options.boardExists ?? true;
	const subscribers = options.subscribers ?? [];
	const consumeAiRequest = options.consumeAiRequest ?? "success";

	return (url: string, init?: RequestInit) => {
		if (url.endsWith("/auth/v1/user")) {
			return new Response(JSON.stringify({ id: USER_ID, email: "user@example.com" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/billing_consume_ai_request")) {
			if (consumeAiRequest === "quota_exceeded") {
				return new Response(
					JSON.stringify({
						code: "P0001",
						message: "AI quota exceeded",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(JSON.stringify({ consumed: true, source: "plan" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_user_telegram_lookup")) {
			const payload = JSON.parse(String(init?.body)) as { p_user_id: string };
			const member = members.find((item) => item.id === payload.p_user_id);

			return new Response(
				JSON.stringify(
					member
						? {
								telegramUsername: member.name === "Person2" ? "test_person2" : null,
								name: member.name,
							}
						: null,
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/chat_board_tasks")) {
			return new Response(
				JSON.stringify({
					board_title: "boardtest1",
					tasks: [],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/chat_telegram_find_subscribers")) {
			const payload = JSON.parse(String(init?.body)) as { p_assignee_names: string[] };
			const lookupNames = new Set(
				payload.p_assignee_names.map((name) => name.trim().toLowerCase()).filter(Boolean),
			);
			const matched = subscribers.filter((subscriber) =>
				lookupNames.has(subscriber.username.trim().toLowerCase()),
			);

			return new Response(JSON.stringify(matched), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
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

function mockOpenRouter(content: string) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = resolveChatFetchUrl(input);

		if (url.endsWith("/auth/v1/user")) {
			return authUserResponse();
		}

		if (url.includes("openrouter.ai")) {
			return new Response(
				JSON.stringify({
					choices: [{ message: { content } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		const rpcResponse = mockSupabaseRpc()(url, init);
		if (rpcResponse) {
			return rpcResponse;
		}

		return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
	});
}

describe("POST /api/chat", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns 401 when user is not authenticated", async () => {
		const request = createChatRequest({ message: "Создать лендинг", boardId: BOARD_ID }, { auth: false });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 403 when AI quota is exceeded", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			if (url.endsWith("/auth/v1/user")) {
				return new Response(JSON.stringify({ id: USER_ID, email: "user@example.com" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			const rpcResponse = mockSupabaseRpc({ consumeAiRequest: "quota_exceeded" })(url, init);
			return rpcResponse ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createChatRequest({ message: "Создать лендинг", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "AI request quota exceeded. Purchase more requests on the Billing page.",
			code: "AI_QUOTA_EXCEEDED",
		});
	});

	it("returns created tasks with round-robin assignees", async () => {
		mockOpenRouter('[{"task":"task1"},{"task":"task2"},{"task":"task3"}]');

		const request = createChatRequest({ message: "Создать лендинг", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<{
			title: string;
			assignee: { id: string };
		}>;

		expect(body).toHaveLength(3);
		expect(body[0]).toMatchObject({
			title: "task1",
			assignee: { id: MEMBER_1.id, name: MEMBER_1.name, email: MEMBER_1.email },
		});
		expect(body[1].assignee.id).toBe(MEMBER_2.id);
		expect(body[2].assignee.id).toBe(MEMBER_1.id);
	});

	it("sends Telegram notifications to subscribed assignees when bot token is configured", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = resolveChatFetchUrl(input);

			if (url.endsWith("/auth/v1/user")) {
				return authUserResponse();
			}

			if (url.includes("/rest/v1/rpc/billing_consume_ai_request")) {
				return consumeAiSuccessResponse();
			}

			if (url.includes("openrouter.ai")) {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: '[{"task":"task1"}]' } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.includes("/sendMessage")) {
				const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
				expect(body.chat_id).toBe(99);
				expect(body.text).toContain("Вам назначена задача на доске «boardtest1»");
				expect(body.text).toContain("task1");
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			const rpcResponse = mockSupabaseRpc({
				subscribers: [{ chat_id: 99, username: "test_person2" }],
			})(url, init);
			return rpcResponse ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createChatRequest({ message: "Создать лендинг", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnvWithTelegram, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalled();
	});

	it("returns 400 when message is empty", async () => {
		const request = createChatRequest({ message: "   ", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Field 'message' is required and must be a non-empty string",
		});
	});

	it("returns 400 when message is missing", async () => {
		const request = createChatRequest({ boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});

	it("returns 400 when boardId is missing or invalid", async () => {
		const request = createChatRequest({ message: "Создать лендинг", boardId: "not-a-uuid" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Field 'boardId' is required and must be a valid UUID",
		});
	});

	it("returns 404 when board is not found", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = resolveChatFetchUrl(input);
			if (url.endsWith("/auth/v1/user")) {
				return authUserResponse();
			}
			if (url.includes("/rest/v1/rpc/billing_consume_ai_request")) {
				return consumeAiSuccessResponse();
			}
			const rpcResponse = mockSupabaseRpc({ boardExists: false })(url, init);
			return rpcResponse ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createChatRequest({ message: "Создать лендинг", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Board not found" });
	});

	it("returns 404 when board has no members", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = resolveChatFetchUrl(input);
			if (url.endsWith("/auth/v1/user")) {
				return authUserResponse();
			}
			if (url.includes("/rest/v1/rpc/billing_consume_ai_request")) {
				return consumeAiSuccessResponse();
			}
			const rpcResponse = mockSupabaseRpc({ members: [] })(url, init);
			return rpcResponse ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createChatRequest({ message: "Создать лендинг", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Board has no members" });
	});

	it("returns 502 when model returns invalid task format", async () => {
		mockOpenRouter("not valid json array");

		const request = createChatRequest({ message: "Создать лендинг", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Invalid task decomposition format from model",
		});
	});

	it("returns 502 when OpenRouter returns an error", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = resolveChatFetchUrl(input);

			if (url.endsWith("/auth/v1/user")) {
				return authUserResponse();
			}

			if (url.includes("/rest/v1/rpc/billing_consume_ai_request")) {
				return consumeAiSuccessResponse();
			}

			if (url.includes("openrouter.ai")) {
				return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				});
			}

			const rpcResponse = mockSupabaseRpc({ members: [MEMBER_1] })(url, init);
			return rpcResponse ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createChatRequest({ message: "Привет", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "Rate limit exceeded" });
	});

	it("returns 500 when OPENROUTER_API_KEY is not configured", async () => {
		const request = createChatRequest({ message: "Привет", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				...env,
				SUPABASE_URL: "https://example.supabase.co",
				SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test",
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "OPENROUTER_API_KEY is not configured" });
	});

	it("returns 500 when Supabase is not configured", async () => {
		const request = createChatRequest({ message: "Привет", boardId: BOARD_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				...env,
				OPENROUTER_API_KEY: "test-api-key",
			} as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Supabase is not configured" });
	});
});
