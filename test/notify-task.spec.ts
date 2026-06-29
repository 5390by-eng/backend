import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const USER_ID = "afd4d08e-df47-4818-b2d9-bbe688ffadf2";
const BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz";

const testEnv = {
	...env,
	TELEGRAM_BOT_TOKEN: BOT_TOKEN,
	SUPABASE_URL: "https://example.supabase.co",
	SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test",
} as Env;

function createNotifyTaskRequest(body: unknown): Request {
	return new IncomingRequest("http://example.com/api/notify-task", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function mockNotifyTaskRpc(options: {
	profile?: { telegramUsername: string | null; name: string } | null;
	subscribers?: Array<{ chat_id: number; username: string }>;
} = {}) {
	const profile =
		"profile" in options
			? options.profile
			: { telegramUsername: "person1", name: "Person1" };
	const subscribers = options.subscribers ?? [{ chat_id: 99, username: "person1" }];

	return (url: string, init?: RequestInit) => {
		if (url.includes("/rest/v1/rpc/chat_user_telegram_lookup")) {
			if (!profile) {
				return new Response(JSON.stringify(null), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response(JSON.stringify(profile), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
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

		return null;
	};
}

describe("POST /api/notify-task", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("notifies user by userId and task title", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

			const rpcResponse = mockNotifyTaskRpc()(url, init);
			if (rpcResponse) {
				return rpcResponse;
			}

			expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
			expect(JSON.parse(String(init?.body))).toEqual({
				chat_id: 99,
				text: "Вам назначена задача на доске «boardtest1»:\n\n• Fix login bug",
			});

			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const request = createNotifyTaskRequest({
			userId: USER_ID,
			task: "Fix login bug",
			boardTitle: "boardtest1",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			notified: true,
			chatId: 99,
			username: "person1",
		});
		expect(fetchMock).toHaveBeenCalled();
	});

	it("returns 404 when user is not found", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const rpcResponse = mockNotifyTaskRpc({ profile: null })(url, init);
			return rpcResponse ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createNotifyTaskRequest({
			userId: USER_ID,
			task: "Fix login bug",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "User not found" });
	});

	it("returns 404 when user is not subscribed", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const rpcResponse = mockNotifyTaskRpc({ subscribers: [] })(url, init);
			return rpcResponse ?? new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createNotifyTaskRequest({
			userId: USER_ID,
			task: "Fix login bug",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "User is not subscribed to Telegram notifications" });
	});

	it("returns 400 when task is missing", async () => {
		const request = createNotifyTaskRequest({ userId: USER_ID });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});

	it("returns 500 when TELEGRAM_BOT_TOKEN is not configured", async () => {
		const request = createNotifyTaskRequest({
			userId: USER_ID,
			task: "Fix login bug",
		});
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
		expect(await response.json()).toEqual({ error: "TELEGRAM_BOT_TOKEN is not configured" });
	});
});
