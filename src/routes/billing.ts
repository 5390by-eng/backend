import { requireAuthenticatedUser } from "../lib/auth";
import { SupabaseError } from "../services/supabase";
import {
	BILLING_PLANS,
	getBillingSubscription,
	getBillingUsage,
	getStripeCustomerId,
	validateTopupAmountUsd,
	calculateAiCreditsFromAmountCents,
	type BillingPlanId,
} from "../services/billing";
import { createAiTopupCheckoutSession, createCheckoutSession, createPortalSession } from "../services/stripe";
import { upsertBillingSubscription } from "../services/billing";

type CheckoutSessionBody = {
	planId?: string;
	successUrl?: string;
	cancelUrl?: string;
};

type PortalSessionBody = {
	returnUrl?: string;
};

type AiTopupCheckoutBody = {
	amountUsd?: number;
	successUrl?: string;
	cancelUrl?: string;
};

function isBillingPlanId(value: string | undefined): value is BillingPlanId {
	return value === "free" || value === "pro" || value === "team";
}

function resolveAppBaseUrl(env: Env, request: Request): string {
	const configured = env.APP_BASE_URL?.trim();
	if (configured) {
		return configured.replace(/\/+$/, "");
	}

	const origin = request.headers.get("Origin")?.trim();
	if (origin) {
		return origin.replace(/\/+$/, "");
	}

	return "http://localhost:5173";
}

function handleBillingError(error: unknown): Response {
	if (error instanceof SupabaseError) {
		return Response.json({ error: error.message }, { status: error.status });
	}

	if (error instanceof Error) {
		const status = error.message.includes("not configured") ? 500 : 400;
		return Response.json({ error: error.message }, { status });
	}

	return Response.json({ error: "Billing request failed" }, { status: 500 });
}

export async function handleBillingSubscription(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "GET") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const user = await requireAuthenticatedUser(request, env);
		const subscription = await getBillingSubscription(env, user.id);
		return Response.json(subscription);
	} catch (error) {
		return handleBillingError(error);
	}
}

export async function handleBillingUsage(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const user = await requireAuthenticatedUser(request, env);
		const usage = await getBillingUsage(env, user.id);
		return Response.json(usage);
	} catch (error) {
		return handleBillingError(error);
	}
}

export async function handleBillingPlans(_request: Request, _env: Env): Promise<Response> {
	return Response.json(BILLING_PLANS);
}

export async function handleBillingCheckoutSession(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const user = await requireAuthenticatedUser(request, env);
		const body = (await request.json()) as CheckoutSessionBody;

		if (!isBillingPlanId(body.planId) || body.planId === "free") {
			return Response.json({ error: "Invalid planId for checkout" }, { status: 400 });
		}

		const appBaseUrl = resolveAppBaseUrl(env, request);
		const successUrl =
			body.successUrl?.trim() ||
			`${appBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
		const cancelUrl = body.cancelUrl?.trim() || `${appBaseUrl}/billing/cancel`;

		const existingCustomerId = await getStripeCustomerId(env, user.id);
		const session = await createCheckoutSession(env, {
			userId: user.id,
			email: user.email,
			planId: body.planId,
			successUrl,
			cancelUrl,
			customerId: existingCustomerId,
		});

		if (session.customer && typeof session.customer === "string") {
			await upsertBillingSubscription(env, {
				userId: user.id,
				planId: (await getBillingSubscription(env, user.id)).planId,
				status: "active",
				stripeCustomerId: session.customer,
			});
		}

		if (!session.url) {
			return Response.json({ error: "Failed to create checkout session" }, { status: 502 });
		}

		return Response.json({ url: session.url });
	} catch (error) {
		return handleBillingError(error);
	}
}

export async function handleBillingPortal(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const user = await requireAuthenticatedUser(request, env);
		const body = (await request.json()) as PortalSessionBody;
		const appBaseUrl = resolveAppBaseUrl(env, request);
		const returnUrl = body.returnUrl?.trim() || `${appBaseUrl}/billing`;

		const customerId = await getStripeCustomerId(env, user.id);
		if (!customerId) {
			return Response.json({ error: "No Stripe customer found for this user" }, { status: 400 });
		}

		const session = await createPortalSession(env, customerId, returnUrl);
		if (!session.url) {
			return Response.json({ error: "Failed to create portal session" }, { status: 502 });
		}

		return Response.json({ url: session.url });
	} catch (error) {
		return handleBillingError(error);
	}
}

export async function handleBillingAiTopupCheckoutSession(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const user = await requireAuthenticatedUser(request, env);
		const body = (await request.json()) as AiTopupCheckoutBody;

		if (typeof body.amountUsd !== "number") {
			return Response.json({ error: "Field 'amountUsd' is required and must be a number" }, { status: 400 });
		}

		const amountCents = validateTopupAmountUsd(env, body.amountUsd);
		const estimatedCredits = calculateAiCreditsFromAmountCents(amountCents);

		const appBaseUrl = resolveAppBaseUrl(env, request);
		const successUrl =
			body.successUrl?.trim() ||
			`${appBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}&type=ai_topup`;
		const cancelUrl = body.cancelUrl?.trim() || `${appBaseUrl}/billing/cancel`;

		const existingCustomerId = await getStripeCustomerId(env, user.id);
		const session = await createAiTopupCheckoutSession(env, {
			userId: user.id,
			email: user.email,
			amountCents,
			successUrl,
			cancelUrl,
			customerId: existingCustomerId,
		});

		if (session.customer && typeof session.customer === "string") {
			await upsertBillingSubscription(env, {
				userId: user.id,
				planId: (await getBillingSubscription(env, user.id)).planId,
				status: "active",
				stripeCustomerId: session.customer,
			});
		}

		if (!session.url) {
			return Response.json({ error: "Failed to create checkout session" }, { status: 502 });
		}

		return Response.json({
			url: session.url,
			estimatedCredits,
			amountCents,
		});
	} catch (error) {
		return handleBillingError(error);
	}
}
