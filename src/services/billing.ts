import { resolveSupabaseApiKey, type SupabaseConfig, SupabaseError } from "./supabase";

export type BillingPlanId = "free" | "pro" | "team";

export type BillingSubscription = {
	planId: BillingPlanId;
	status: "active" | "trialing" | "canceled" | "past_due";
	currentPeriodEnd: string;
	cancelAtPeriodEnd: boolean;
	stripeCustomerId: string | null;
};

export type BillingUsage = {
	boardsUsed: number;
	tasksUsed: number;
	aiRequestsUsed: number;
	teamMembersUsed: number;
	aiRequestsPlanLimit: number;
	aiCreditsBalance: number;
	aiRequestsEffectiveLimit: number;
	aiRequestsRemaining: number;
};

export type AiCreditsRecord = {
	inserted: boolean;
	creditsAdded: number;
};

export const AI_CREDIT_PRICE_USD = 0.5;
export const AI_CREDIT_PRICE_CENTS = 50;

export type BillingPaymentRecord = {
	inserted: boolean;
};

export const BILLING_PLANS = [
	{
		id: "free" as const,
		name: "Free",
		price: 0,
		interval: "month" as const,
		features: ["3 boards", "50 tasks", "No AI requests", "3 team members"],
		limits: { boards: 3, tasks: 50, aiRequests: 0, teamMembers: 3 },
	},
	{
		id: "pro" as const,
		name: "Pro",
		price: 19,
		interval: "month" as const,
		features: ["Unlimited boards", "500 tasks", "100 AI requests", "5 team members"],
		limits: { boards: 999, tasks: 500, aiRequests: 100, teamMembers: 5 },
	},
	{
		id: "team" as const,
		name: "Team",
		price: 49,
		interval: "month" as const,
		features: [
			"Unlimited boards",
			"Unlimited tasks",
			"500 AI requests",
			"Unlimited team members",
			"Telegram notifications",
			"Create tasks from Telegram",
		],
		limits: { boards: 999, tasks: 9999, aiRequests: 500, teamMembers: 999 },
	},
];

function getSupabaseConfig(env: Env): SupabaseConfig {
	return supabaseConfigFromEnv(env);
}

async function billingRpc<T>(env: Env, functionName: string, body: unknown): Promise<T> {
	const config = getSupabaseConfig(env);
	const baseUrl = config.url.replace(/\/+$/, "");
	const response = await fetch(`${baseUrl}/rest/v1/rpc/${functionName}`, {
		method: "POST",
		headers: {
			apikey: config.apiKey,
			Authorization: config.apiKey.startsWith("eyJ") ? `Bearer ${config.apiKey}` : "",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const errorText = await response.text();

	if (!response.ok) {
		let message = "Supabase billing request failed";
		try {
			const parsed = errorText
				? (JSON.parse(errorText) as { message?: string; hint?: string; error?: string })
				: {};
			message = parsed.message ?? parsed.hint ?? parsed.error ?? message;
		} catch {
			if (errorText) {
				message = errorText.slice(0, 200);
			}
		}

		throw new SupabaseError(message, response.status);
	}

	if (!errorText) {
		return null as T;
	}

	return JSON.parse(errorText) as T;
}

function parseSubscription(raw: Record<string, unknown>): BillingSubscription {
	const planId = raw.planId;
	const status = raw.status;

	return {
		planId: planId === "pro" || planId === "team" ? planId : "free",
		status:
			status === "trialing" || status === "canceled" || status === "past_due"
				? status
				: "active",
		currentPeriodEnd:
			typeof raw.currentPeriodEnd === "string"
				? raw.currentPeriodEnd
				: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
		cancelAtPeriodEnd: raw.cancelAtPeriodEnd === true,
		stripeCustomerId:
			typeof raw.stripeCustomerId === "string" && raw.stripeCustomerId.trim() !== ""
				? raw.stripeCustomerId
				: null,
	};
}

export async function getBillingSubscription(
	env: Env,
	userId: string,
): Promise<BillingSubscription> {
	const result = await billingRpc<Record<string, unknown>>(env, "billing_get_subscription", {
		p_user_id: userId,
	});

	return parseSubscription(result ?? {});
}

export async function upsertBillingSubscription(
	env: Env,
	input: {
		userId: string;
		planId: BillingPlanId;
		status: BillingSubscription["status"];
		stripeCustomerId?: string | null;
		stripeSubscriptionId?: string | null;
		currentPeriodEnd?: string | null;
		cancelAtPeriodEnd?: boolean;
	},
): Promise<BillingSubscription> {
	const result = await billingRpc<Record<string, unknown>>(env, "billing_upsert_subscription", {
		p_user_id: input.userId,
		p_plan_id: input.planId,
		p_status: input.status,
		p_stripe_customer_id: input.stripeCustomerId ?? null,
		p_stripe_subscription_id: input.stripeSubscriptionId ?? null,
		p_current_period_end: input.currentPeriodEnd ?? null,
		p_cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
	});

	return parseSubscription(result ?? {});
}

export async function recordBillingPayment(
	env: Env,
	input: {
		userId: string;
		stripeEventId: string;
		stripeInvoiceId?: string | null;
		stripePaymentIntentId?: string | null;
		amount: number;
		currency: string;
		status: string;
		planId?: BillingPlanId | null;
		metadata?: Record<string, unknown>;
	},
): Promise<BillingPaymentRecord> {
	const result = await billingRpc<{ inserted?: boolean }>(env, "billing_record_payment", {
		p_user_id: input.userId,
		p_stripe_event_id: input.stripeEventId,
		p_stripe_invoice_id: input.stripeInvoiceId ?? null,
		p_stripe_payment_intent_id: input.stripePaymentIntentId ?? null,
		p_amount: input.amount,
		p_currency: input.currency,
		p_status: input.status,
		p_plan_id: input.planId ?? null,
		p_metadata: input.metadata ?? {},
	});

	return { inserted: result?.inserted === true };
}

export async function getBillingUsage(env: Env, userId: string): Promise<BillingUsage> {
	const result = await billingRpc<Record<string, unknown>>(env, "billing_get_usage", {
		p_user_id: userId,
	});

	const boardsUsed = typeof result?.boardsUsed === "number" ? result.boardsUsed : 0;
	const tasksUsed = typeof result?.tasksUsed === "number" ? result.tasksUsed : 0;
	const aiRequestsUsed = typeof result?.aiRequestsUsed === "number" ? result.aiRequestsUsed : 0;
	const teamMembersUsed =
		typeof result?.teamMembersUsed === "number" ? result.teamMembersUsed : 0;
	const aiRequestsPlanLimit =
		typeof result?.aiRequestsPlanLimit === "number" ? result.aiRequestsPlanLimit : 0;
	const aiCreditsBalance =
		typeof result?.aiCreditsBalance === "number" ? result.aiCreditsBalance : 0;
	const aiRequestsRemainingRaw =
		typeof result?.aiRequestsRemaining === "number" ? result.aiRequestsRemaining : 0;
	const aiRequestsEffectiveLimitRaw =
		typeof result?.aiRequestsEffectiveLimit === "number"
			? result.aiRequestsEffectiveLimit
			: 0;

	const purchasedPool = aiRequestsPlanLimit + aiCreditsBalance;
	const aiRequestsEffectiveLimit = Math.max(
		aiRequestsEffectiveLimitRaw,
		aiRequestsRemainingRaw + aiRequestsUsed,
		purchasedPool,
	);
	const aiRequestsRemaining = Math.max(
		aiRequestsRemainingRaw,
		aiRequestsEffectiveLimit - aiRequestsUsed,
	);

	return {
		boardsUsed,
		tasksUsed,
		aiRequestsUsed,
		teamMembersUsed,
		aiRequestsPlanLimit,
		aiCreditsBalance,
		aiRequestsEffectiveLimit,
		aiRequestsRemaining,
	};
}

export async function addAiCredits(
	env: Env,
	input: {
		userId: string;
		credits: number;
		stripeEventId: string;
		metadata?: Record<string, unknown>;
	},
): Promise<AiCreditsRecord> {
	const result = await billingRpc<{ inserted?: boolean; creditsAdded?: number }>(
		env,
		"billing_add_ai_credits",
		{
			p_user_id: input.userId,
			p_credits: input.credits,
			p_stripe_event_id: input.stripeEventId,
			p_metadata: input.metadata ?? {},
		},
	);

	return {
		inserted: result?.inserted === true,
		creditsAdded: typeof result?.creditsAdded === "number" ? result.creditsAdded : 0,
	};
}

export async function consumeAiRequest(env: Env, userId: string): Promise<void> {
	await billingRpc<{ consumed?: boolean }>(env, "billing_consume_ai_request", {
		p_user_id: userId,
	});
}

export function calculateAiCreditsFromAmountCents(amountCents: number): number {
	return Math.floor(amountCents / AI_CREDIT_PRICE_CENTS);
}

export function resolveTopupMinUsd(env: Env): number {
	const configured = Number(env.STRIPE_AI_TOPUP_MIN_USD);
	return Number.isFinite(configured) && configured > 0 ? configured : AI_CREDIT_PRICE_USD;
}

export function resolveTopupMaxUsd(env: Env): number {
	const configured = Number(env.STRIPE_AI_TOPUP_MAX_USD);
	return Number.isFinite(configured) && configured > 0 ? configured : 500;
}

export function validateTopupAmountUsd(env: Env, amountUsd: number): number {
	const minUsd = resolveTopupMinUsd(env);
	const maxUsd = resolveTopupMaxUsd(env);

	if (!Number.isFinite(amountUsd) || amountUsd < minUsd) {
		throw new SupabaseError(`Minimum top-up amount is $${minUsd}`, 400);
	}

	if (amountUsd > maxUsd) {
		throw new SupabaseError(`Maximum top-up amount is $${maxUsd}`, 400);
	}

	const amountCents = Math.round(amountUsd * 100);
	const credits = calculateAiCreditsFromAmountCents(amountCents);

	if (credits < 1) {
		throw new SupabaseError(
			`Amount must be at least $${AI_CREDIT_PRICE_USD} to purchase AI requests`,
			400,
		);
	}

	return amountCents;
}

export async function getStripeCustomerId(env: Env, userId: string): Promise<string | null> {
	const customerId = await billingRpc<string | null>(env, "billing_get_stripe_customer_id", {
		p_user_id: userId,
	});

	return typeof customerId === "string" && customerId.trim() !== "" ? customerId : null;
}

export async function getUserIdByStripeCustomer(
	env: Env,
	stripeCustomerId: string,
): Promise<string | null> {
	const userId = await billingRpc<string | null>(env, "billing_get_user_by_stripe_customer", {
		p_stripe_customer_id: stripeCustomerId,
	});

	return typeof userId === "string" && userId.trim() !== "" ? userId : null;
}

export function supabaseConfigFromEnv(env: Env): SupabaseConfig {
	return {
		url: env.SUPABASE_URL,
		apiKey: resolveSupabaseApiKey(env),
	};
}

export function resolveStripePriceId(env: Env, planId: BillingPlanId): string | null {
	if (planId === "pro") {
		return env.STRIPE_PRICE_PRO?.trim() || null;
	}

	if (planId === "team") {
		return env.STRIPE_PRICE_TEAM?.trim() || null;
	}

	return null;
}

export function planIdFromStripePriceId(env: Env, priceId: string): BillingPlanId | null {
	const normalized = priceId.trim();
	if (normalized && normalized === env.STRIPE_PRICE_PRO?.trim()) {
		return "pro";
	}

	if (normalized && normalized === env.STRIPE_PRICE_TEAM?.trim()) {
		return "team";
	}

	return null;
}
