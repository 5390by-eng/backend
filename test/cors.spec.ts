import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const BOARD_ID = "4349e4fd-03df-4e56-8b29-b618dad9914f";
const MEMBER = {
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
	SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test",
} as Env;

function mockSuccessfulChatFetch(content: string) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		if (url.endsWith("/auth/v1/user")) {
			return new Response(JSON.stringify({ id: MEMBER.id, email: MEMBER.email }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/billing_consume_ai_request")) {
			return new Response(JSON.stringify({ consumed: true, source: "plan" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("openrouter.ai")) {
			return new Response(
				JSON.stringify({
					choices: [{ message: { content } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/chat_board_exists")) {
			return new Response(JSON.stringify(true), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_board_members")) {
			return new Response(JSON.stringify([MEMBER]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/chat_create_tasks")) {
			const payload = JSON.parse(String(init?.body)) as {
				p_board_id: string;
				p_tasks: Array<{ title: string; assignee_id: string }>;
			};

			return new Response(
				JSON.stringify(
					payload.p_tasks.map((task, index) => ({
						id: `task-${index + 1}`,
						title: task.title,
						boardId: payload.p_board_id,
						status: "backlog",
						priority: "medium",
						assignee: {
							id: MEMBER.id,
							name: MEMBER.name,
							email: MEMBER.email,
							role: MEMBER.role,
							teamRole: MEMBER.teamRole,
						},
					})),
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
	});
}

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
		mockSuccessfulChatFetch('[{"task":"task1"},{"task":"task2"}]');

		const request = new IncomingRequest("http://example.com/api/chat", {
			method: "POST",
			headers: {
				Origin: "http://localhost:5173",
				"Content-Type": "application/json",
				Authorization: "Bearer valid-token",
			},
			body: JSON.stringify({ message: "Привет", boardId: BOARD_ID }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
		expect(await response.json()).toEqual([
			{
				id: "task-1",
				title: "task1",
				boardId: BOARD_ID,
				status: "backlog",
				priority: "medium",
				assignee: {
					id: MEMBER.id,
					name: MEMBER.name,
					email: MEMBER.email,
					role: MEMBER.role,
					teamRole: MEMBER.teamRole,
				},
			},
			{
				id: "task-2",
				title: "task2",
				boardId: BOARD_ID,
				status: "backlog",
				priority: "medium",
				assignee: {
					id: MEMBER.id,
					name: MEMBER.name,
					email: MEMBER.email,
					role: MEMBER.role,
					teamRole: MEMBER.teamRole,
				},
			},
		]);
	});

	it("does not add CORS headers for disallowed origin", async () => {
		mockSuccessfulChatFetch('[{"task":"task1"}]');

		const request = new IncomingRequest("http://example.com/api/chat", {
			method: "POST",
			headers: {
				Origin: "http://evil.example.com",
				"Content-Type": "application/json",
				Authorization: "Bearer valid-token",
			},
			body: JSON.stringify({ message: "Привет", boardId: BOARD_ID }),
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
