import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SUPABASE_URL = "https://example.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test";
const OPENROUTER_API_KEY = "test-openrouter-key";
const BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz";
const WEBHOOK_SECRET = "test-webhook-secret";
const USER_ID = "7ed99ca8-7ac7-4f25-bc30-a9de1aef3719";

const testEnv = {
	...env,
	SUPABASE_URL,
	SUPABASE_ANON_KEY: SUPABASE_KEY,
	OPENROUTER_API_KEY,
	TELEGRAM_BOT_TOKEN: BOT_TOKEN,
	TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
	STRIPE_SECRET_KEY: "sk_test_123",
	STRIPE_WEBHOOK_SECRET: "whsec_test",
	STRIPE_PRICE_PRO: "price_pro_test",
	STRIPE_PRICE_TEAM: "price_team_test",
	APP_BASE_URL: "http://localhost:5173",
} as Env;

function mockAuthUser() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);

		if (url.endsWith("/auth/v1/user")) {
			return new Response(JSON.stringify({ id: USER_ID, email: "user@example.com" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/rest/v1/rpc/billing_get_subscription")) {
			return new Response(
				JSON.stringify({
					planId: "free",
					status: "active",
					currentPeriodEnd: "2026-07-01T00:00:00.000Z",
					cancelAtPeriodEnd: false,
					stripeCustomerId: null,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/billing_get_usage")) {
			return new Response(
				JSON.stringify({
					boardsUsed: 2,
					tasksUsed: 10,
					aiRequestsUsed: 0,
					teamMembersUsed: 1,
					aiRequestsPlanLimit: 0,
					aiCreditsBalance: 0,
					aiRequestsEffectiveLimit: 0,
					aiRequestsRemaining: 0,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/billing_get_stripe_customer_id")) {
			return new Response(JSON.stringify(null), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("api.stripe.com")) {
			return new Response(
				JSON.stringify({
					id: "cs_test_topup",
					url: "https://checkout.stripe.com/c/pay/cs_test_topup",
					customer: "cus_test",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.includes("/rest/v1/rpc/billing_upsert_subscription")) {
			return new Response(
				JSON.stringify({
					planId: "free",
					status: "active",
					currentPeriodEnd: "2026-07-01T00:00:00.000Z",
					cancelAtPeriodEnd: false,
					stripeCustomerId: "cus_test",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		return new Response("not found", { status: 404 });
	});
}

describe("billing routes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns subscription for authenticated user", async () => {
		mockAuthUser();
		const request = new IncomingRequest("http://example.com/api/billing/subscription", {
			method: "GET",
			headers: {
				Authorization: "Bearer valid-token",
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { planId: string };
		expect(body.planId).toBe("free");
	});

	it("returns usage for authenticated user", async () => {
		mockAuthUser();
		const request = new IncomingRequest("http://example.com/api/billing/usage", {
			method: "GET",
			headers: {
				Authorization: "Bearer valid-token",
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { boardsUsed: number };
		expect(body.boardsUsed).toBe(2);
	});

	it("returns plans without auth", async () => {
		const request = new IncomingRequest("http://example.com/api/billing/plans", {
			method: "GET",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<{ id: string }>;
		expect(body.some((plan) => plan.id === "pro")).toBe(true);
	});

	it("rejects stripe webhook without signature", async () => {
		const request = new IncomingRequest("http://example.com/stripe/webhook", {
			method: "POST",
			body: "{}",
			headers: { "Content-Type": "application/json" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
	});

	it("creates ai topup checkout session for authenticated user", async () => {
		mockAuthUser();
		const request = new IncomingRequest("http://example.com/api/billing/ai-topup-checkout-session", {
			method: "POST",
			headers: {
				Authorization: "Bearer valid-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ amountUsd: 5 }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { url: string; estimatedCredits: number };
		expect(body.url).toContain("checkout.stripe.com");
		expect(body.estimatedCredits).toBe(10);
	});
});
