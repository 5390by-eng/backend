import {
	extractChatIdFromUpdate,
	isValidWebhookSecret,
	sendMessage,
	TelegramError,
	type TelegramUpdate,
} from "../services/telegram";

const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

export async function handleTelegram(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	if (!env.TELEGRAM_BOT_TOKEN) {
		return Response.json({ error: "TELEGRAM_BOT_TOKEN is not configured" }, { status: 500 });
	}

	if (!env.TELEGRAM_WEBHOOK_SECRET) {
		return Response.json({ error: "TELEGRAM_WEBHOOK_SECRET is not configured" }, { status: 500 });
	}

	const providedSecret = request.headers.get(WEBHOOK_SECRET_HEADER);
	if (!isValidWebhookSecret(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	let update: TelegramUpdate;

	try {
		update = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const chatId = extractChatIdFromUpdate(update);
	if (chatId === null) {
		return new Response("ok", { status: 200 });
	}

	try {
		await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "ok");
		return new Response("ok", { status: 200 });
	} catch (error) {
		console.error("handleTelegram failed:", error);

		if (error instanceof TelegramError || (error instanceof Error && error.name === "TelegramError")) {
			const status =
				error instanceof TelegramError && error.status >= 400 && error.status < 600
					? error.status
					: 502;
			return Response.json({ error: error.message }, { status });
		}

		if (error instanceof Error) {
			return Response.json({ error: error.message }, { status: 500 });
		}

		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
