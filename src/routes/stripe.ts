import type Stripe from "stripe";
import {
	addAiCredits,
	getBillingSubscription,
	getUserIdByStripeCustomer,
	planIdFromStripePriceId,
	recordBillingPayment,
	upsertBillingSubscription,
	calculateAiCreditsFromAmountCents,
	type BillingPlanId,
} from "../services/billing";
import {
	constructStripeEvent,
	extractPlanIdFromSubscription,
	mapSubscriptionStatus,
	resolveUserIdFromMetadata,
	unixToIso,
} from "../services/stripe";

async function resolveUserIdFromCheckoutSession(
	session: Stripe.Checkout.Session,
): Promise<string | null> {
	if (typeof session.client_reference_id === "string" && session.client_reference_id.trim() !== "") {
		return session.client_reference_id;
	}

	return resolveUserIdFromMetadata(session.metadata);
}

async function handleCheckoutSessionCompleted(
	env: Env,
	event: Stripe.Event,
	session: Stripe.Checkout.Session,
): Promise<void> {
	if (session.metadata?.type === "ai_topup") {
		await handleAiTopupCheckoutCompleted(env, event, session);
		return;
	}

	const userId = await resolveUserIdFromCheckoutSession(session);
	if (!userId) {
		console.error("checkout.session.completed without user_id", event.id);
		return;
	}

	const metadataPlan = session.metadata?.plan_id;
	const planId: BillingPlanId =
		metadataPlan === "pro" || metadataPlan === "team" ? metadataPlan : "pro";

	const stripeCustomerId =
		typeof session.customer === "string"
			? session.customer
			: session.customer && "id" in session.customer
				? session.customer.id
				: null;

	const stripeSubscriptionId =
		typeof session.subscription === "string"
			? session.subscription
			: session.subscription && "id" in session.subscription
				? session.subscription.id
				: null;

	await upsertBillingSubscription(env, {
		userId,
		planId,
		status: "active",
		stripeCustomerId,
		stripeSubscriptionId,
		currentPeriodEnd: null,
		cancelAtPeriodEnd: false,
	});

	await recordBillingPayment(env, {
		userId,
		stripeEventId: event.id,
		stripeInvoiceId: null,
		stripePaymentIntentId:
			typeof session.payment_intent === "string" ? session.payment_intent : null,
		amount: session.amount_total ?? 0,
		currency: session.currency ?? "usd",
		status: "completed",
		planId,
		metadata: {
			checkoutSessionId: session.id,
			mode: session.mode,
		},
	});
}

async function handleAiTopupCheckoutCompleted(
	env: Env,
	event: Stripe.Event,
	session: Stripe.Checkout.Session,
): Promise<void> {
	const userId = await resolveUserIdFromCheckoutSession(session);
	if (!userId) {
		console.error("ai_topup checkout.session.completed without user_id", event.id);
		return;
	}

	const amountCents = session.amount_total ?? 0;
	const metadataCredits = Number(session.metadata?.credits);
	const credits =
		Number.isFinite(metadataCredits) && metadataCredits > 0
			? Math.floor(metadataCredits)
			: calculateAiCreditsFromAmountCents(amountCents);

	if (credits < 1) {
		console.error("ai_topup checkout.session.completed with invalid credits", event.id);
		return;
	}

	await recordBillingPayment(env, {
		userId,
		stripeEventId: event.id,
		stripeInvoiceId: null,
		stripePaymentIntentId:
			typeof session.payment_intent === "string" ? session.payment_intent : null,
		amount: amountCents,
		currency: session.currency ?? "usd",
		status: "completed",
		planId: null,
		metadata: {
			type: "ai_topup",
			checkoutSessionId: session.id,
			credits,
		},
	});

	await addAiCredits(env, {
		userId,
		credits,
		stripeEventId: event.id,
		metadata: {
			checkoutSessionId: session.id,
			amountCents,
		},
	});
}

async function handleInvoicePaid(env: Env, event: Stripe.Event, invoice: Stripe.Invoice): Promise<void> {
	const subscriptionDetails = invoice.parent?.subscription_details;
	const subscriptionMetadata = subscriptionDetails?.metadata;
	let userId = resolveUserIdFromMetadata(subscriptionMetadata ?? null);

	if (!userId) {
		userId = resolveUserIdFromMetadata(invoice.metadata);
	}

	if (!userId) {
		const customerId =
			typeof invoice.customer === "string"
				? invoice.customer
				: invoice.customer && "id" in invoice.customer
					? invoice.customer.id
					: null;

		if (customerId) {
			userId = await getUserIdByStripeCustomer(env, customerId);
		}
	}

	if (!userId) {
		console.error("invoice.paid without user_id", event.id);
		return;
	}

	const lineItem = invoice.lines?.data?.[0];
	const priceRef = lineItem?.price;
	const priceId = typeof priceRef === "string" ? priceRef : priceRef?.id;
	const currentSubscription = await getBillingSubscription(env, userId);
	const resolvedPlanId: BillingPlanId =
		(typeof priceId === "string" ? planIdFromStripePriceId(env, priceId) : null) ??
		currentSubscription.planId;

	await recordBillingPayment(env, {
		userId,
		stripeEventId: event.id,
		stripeInvoiceId: invoice.id,
		stripePaymentIntentId:
			typeof invoice.payment_intent === "string" ? invoice.payment_intent : null,
		amount: invoice.amount_paid ?? 0,
		currency: invoice.currency ?? "usd",
		status: "paid",
		planId: resolvedPlanId,
		metadata: {
			invoiceNumber: invoice.number,
			billingReason: invoice.billing_reason,
		},
	});

	const periodEnd = lineItem?.period?.end;
	if (typeof periodEnd === "number") {
		await upsertBillingSubscription(env, {
			userId,
			planId: resolvedPlanId,
			status: "active",
			currentPeriodEnd: unixToIso(periodEnd),
			cancelAtPeriodEnd: false,
		});
	}
}

async function handleSubscriptionUpdated(
	env: Env,
	subscription: Stripe.Subscription,
): Promise<void> {
	const userId = resolveUserIdFromMetadata(subscription.metadata);
	if (!userId) {
		console.error("customer.subscription.updated without user_id", subscription.id);
		return;
	}

	const planId = extractPlanIdFromSubscription(env, subscription) ?? "pro";

	await upsertBillingSubscription(env, {
		userId,
		planId,
		status: mapSubscriptionStatus(subscription.status),
		stripeCustomerId:
			typeof subscription.customer === "string" ? subscription.customer : null,
		stripeSubscriptionId: subscription.id,
		currentPeriodEnd: unixToIso(subscription.current_period_end),
		cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
	});
}

async function handleSubscriptionDeleted(
	env: Env,
	subscription: Stripe.Subscription,
): Promise<void> {
	const userId = resolveUserIdFromMetadata(subscription.metadata);
	if (!userId) {
		console.error("customer.subscription.deleted without user_id", subscription.id);
		return;
	}

	await upsertBillingSubscription(env, {
		userId,
		planId: "free",
		status: "canceled",
		stripeCustomerId:
			typeof subscription.customer === "string" ? subscription.customer : null,
		stripeSubscriptionId: subscription.id,
		currentPeriodEnd: unixToIso(subscription.current_period_end),
		cancelAtPeriodEnd: false,
	});
}

async function processStripeEvent(env: Env, event: Stripe.Event): Promise<void> {
	switch (event.type) {
		case "checkout.session.completed":
			await handleCheckoutSessionCompleted(
				env,
				event,
				event.data.object as Stripe.Checkout.Session,
			);
			break;
		case "invoice.paid":
			await handleInvoicePaid(env, event, event.data.object as Stripe.Invoice);
			break;
		case "customer.subscription.updated":
			await handleSubscriptionUpdated(env, event.data.object as Stripe.Subscription);
			break;
		case "customer.subscription.deleted":
			await handleSubscriptionDeleted(env, event.data.object as Stripe.Subscription);
			break;
		default:
			break;
	}
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const rawBody = await request.text();
		const signature = request.headers.get("Stripe-Signature");
		const event = await constructStripeEvent(env, rawBody, signature);

		await processStripeEvent(env, event);

		return Response.json({ received: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Webhook processing failed";
		const status = message.includes("signature") || message.includes("Stripe-Signature") ? 400 : 500;
		console.error("Stripe webhook error:", message);
		return Response.json({ error: message }, { status });
	}
}
