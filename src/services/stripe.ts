import Stripe from "stripe";
import type { BillingPlanId } from "./billing";
import {
	AI_CREDIT_PRICE_CENTS,
	calculateAiCreditsFromAmountCents,
	planIdFromStripePriceId,
	resolveStripePriceId,
} from "./billing";

export function createStripeClient(env: Env): Stripe {
	const secretKey = env.STRIPE_SECRET_KEY?.trim();
	if (!secretKey) {
		throw new Error("STRIPE_SECRET_KEY is not configured");
	}

	return new Stripe(secretKey, {
		httpClient: Stripe.createFetchHttpClient(),
	});
}

export async function createCheckoutSession(
	env: Env,
	input: {
		userId: string;
		email: string | null;
		planId: BillingPlanId;
		successUrl: string;
		cancelUrl: string;
		customerId?: string | null;
	},
): Promise<Stripe.Checkout.Session> {
	if (input.planId === "free") {
		throw new Error("Free plan does not require checkout");
	}

	const priceId = resolveStripePriceId(env, input.planId);
	if (!priceId) {
		throw new Error(`Stripe price is not configured for plan ${input.planId}`);
	}

	const stripe = createStripeClient(env);
	const sessionParams: Stripe.Checkout.SessionCreateParams = {
		mode: "subscription",
		line_items: [{ price: priceId, quantity: 1 }],
		success_url: input.successUrl,
		cancel_url: input.cancelUrl,
		client_reference_id: input.userId,
		metadata: {
			user_id: input.userId,
			plan_id: input.planId,
		},
		subscription_data: {
			metadata: {
				user_id: input.userId,
				plan_id: input.planId,
			},
		},
	};

	if (input.customerId) {
		sessionParams.customer = input.customerId;
	} else if (input.email) {
		sessionParams.customer_email = input.email;
	}

	return stripe.checkout.sessions.create(sessionParams);
}

export async function createPortalSession(
	env: Env,
	customerId: string,
	returnUrl: string,
): Promise<Stripe.BillingPortal.Session> {
	const stripe = createStripeClient(env);

	return stripe.billingPortal.sessions.create({
		customer: customerId,
		return_url: returnUrl,
	});
}

export async function createAiTopupCheckoutSession(
	env: Env,
	input: {
		userId: string;
		email: string | null;
		amountCents: number;
		successUrl: string;
		cancelUrl: string;
		customerId?: string | null;
	},
): Promise<Stripe.Checkout.Session> {
	if (input.amountCents < AI_CREDIT_PRICE_CENTS) {
		throw new Error(`Minimum top-up amount is $${AI_CREDIT_PRICE_CENTS / 100}`);
	}

	const credits = calculateAiCreditsFromAmountCents(input.amountCents);
	const stripe = createStripeClient(env);

	const sessionParams: Stripe.Checkout.SessionCreateParams = {
		mode: "payment",
		line_items: [
			{
				price_data: {
					currency: "usd",
					unit_amount: input.amountCents,
					product_data: {
						name: "AI Request Credits",
						description: `${credits} AI request${credits === 1 ? "" : "s"} at $0.50 each`,
					},
				},
				quantity: 1,
			},
		],
		success_url: input.successUrl,
		cancel_url: input.cancelUrl,
		client_reference_id: input.userId,
		metadata: {
			type: "ai_topup",
			user_id: input.userId,
			credits: String(credits),
			amount_cents: String(input.amountCents),
		},
	};

	if (input.customerId) {
		sessionParams.customer = input.customerId;
	} else if (input.email) {
		sessionParams.customer_email = input.email;
	}

	return stripe.checkout.sessions.create(sessionParams);
}

export { calculateAiCreditsFromAmountCents };

export async function constructStripeEvent(
	env: Env,
	rawBody: string,
	signature: string | null,
): Promise<Stripe.Event> {
	const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
	if (!webhookSecret) {
		throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
	}

	if (!signature) {
		throw new Error("Missing Stripe-Signature header");
	}

	const stripe = createStripeClient(env);
	return stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
}

export function extractPlanIdFromSubscription(
	env: Env,
	subscription: Stripe.Subscription,
): BillingPlanId | null {
	const metadataPlan = subscription.metadata?.plan_id;
	if (metadataPlan === "pro" || metadataPlan === "team") {
		return metadataPlan;
	}

	const firstItem = subscription.items.data[0];
	const priceId = firstItem?.price?.id;
	if (typeof priceId === "string") {
		return planIdFromStripePriceId(env, priceId);
	}

	return null;
}

export function mapSubscriptionStatus(
	status: Stripe.Subscription.Status,
): "active" | "trialing" | "canceled" | "past_due" {
	switch (status) {
		case "trialing":
			return "trialing";
		case "canceled":
		case "unpaid":
		case "incomplete_expired":
			return "canceled";
		case "past_due":
		case "incomplete":
			return "past_due";
		default:
			return "active";
	}
}

export function unixToIso(unixSeconds: number | null | undefined): string | null {
	if (typeof unixSeconds !== "number" || Number.isNaN(unixSeconds)) {
		return null;
	}

	return new Date(unixSeconds * 1000).toISOString();
}

export function resolveUserIdFromMetadata(metadata: Stripe.Metadata | null | undefined): string | null {
	if (!metadata) {
		return null;
	}

	const userId = metadata.user_id ?? metadata.userId;
	return typeof userId === "string" && userId.trim() !== "" ? userId : null;
}
