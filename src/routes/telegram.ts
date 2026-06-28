import {
	answerCallbackQuery,
	buildBoardsInlineKeyboard,
	extractChatIdFromUpdate,
	formatTasksList,
	GET_BOARDS_INLINE_KEYBOARD,
	isGetBoardsCallback,
	isStartCommand,
	isValidWebhookSecret,
	parseBoardCallbackData,
	SELECT_BOARD_MESSAGE,
	sendMessage,
	START_MESSAGE,
	TelegramError,
	type TelegramUpdate,
} from "../services/telegram";
import {
	getAllBoards,
	getBoardTasks,
	isValidUuid,
	resolveSupabaseApiKey,
	SupabaseError,
} from "../services/supabase";

const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

function resolveSupabaseConfig(env: Env): { url: string; apiKey: string } {
	return {
		url: env.SUPABASE_URL.trim(),
		apiKey: resolveSupabaseApiKey(env),
	};
}

async function resolveSupabaseConfigOrReply(
	env: Env,
	botToken: string,
	chatId: number,
): Promise<{ url: string; apiKey: string } | null> {
	if (!env.SUPABASE_URL) {
		await sendMessage(botToken, chatId, "Supabase не настроен.", {
			replyMarkup: GET_BOARDS_INLINE_KEYBOARD,
		});
		return null;
	}

	try {
		return resolveSupabaseConfig(env);
	} catch (error) {
		const message =
			error instanceof SupabaseError ? error.message : "Некорректная конфигурация Supabase.";
		await sendMessage(botToken, chatId, message, { replyMarkup: GET_BOARDS_INLINE_KEYBOARD });
		return null;
	}
}

async function handleGetBoards(env: Env, botToken: string, chatId: number): Promise<void> {
	const supabaseConfig = await resolveSupabaseConfigOrReply(env, botToken, chatId);
	if (!supabaseConfig) {
		return;
	}

	const boards = await getAllBoards(supabaseConfig);
	if (boards.length === 0) {
		await sendMessage(botToken, chatId, "Досок пока нет.");
		return;
	}

	await sendMessage(botToken, chatId, SELECT_BOARD_MESSAGE, {
		replyMarkup: buildBoardsInlineKeyboard(boards),
	});
}

async function handleBoardSelection(
	env: Env,
	botToken: string,
	chatId: number,
	boardId: string,
	callbackQueryId: string,
): Promise<void> {
	await answerCallbackQuery(botToken, callbackQueryId);

	if (!isValidUuid(boardId)) {
		await sendMessage(botToken, chatId, "Некорректная доска.", {
			replyMarkup: GET_BOARDS_INLINE_KEYBOARD,
		});
		return;
	}

	const supabaseConfig = await resolveSupabaseConfigOrReply(env, botToken, chatId);
	if (!supabaseConfig) {
		return;
	}

	const { boardTitle, tasks } = await getBoardTasks(supabaseConfig, boardId);
	await sendMessage(botToken, chatId, formatTasksList(boardTitle, tasks));
}

async function notifyCallbackError(botToken: string, chatId: number, message: string): Promise<void> {
	try {
		await sendMessage(botToken, chatId, message);
	} catch (notifyError) {
		console.error("Failed to notify user about callback error:", notifyError);
	}
}

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

	const text = update.message?.text;
	const callbackData = update.callback_query?.data;
	const boardId = parseBoardCallbackData(callbackData);

	try {
		if (boardId && update.callback_query) {
			await handleBoardSelection(
				env,
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				boardId,
				update.callback_query.id,
			);
			return new Response("ok", { status: 200 });
		}

		if (isGetBoardsCallback(callbackData) && update.callback_query) {
			await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, update.callback_query.id);
			await handleGetBoards(env, env.TELEGRAM_BOT_TOKEN, chatId);
			return new Response("ok", { status: 200 });
		}

		if (isStartCommand(text)) {
			await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, START_MESSAGE, {
				replyMarkup: GET_BOARDS_INLINE_KEYBOARD,
			});
			return new Response("ok", { status: 200 });
		}

		return new Response("ok", { status: 200 });
	} catch (error) {
		console.error("handleTelegram failed:", error);

		if (update.callback_query && chatId !== null) {
			await notifyCallbackError(
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				"Не удалось выполнить действие. Попробуйте ещё раз.",
			);
		}

		if (error instanceof TelegramError || (error instanceof Error && error.name === "TelegramError")) {
			const status =
				error instanceof TelegramError && error.status >= 400 && error.status < 600
					? error.status
					: 502;
			return Response.json({ error: error.message }, { status });
		}

		if (error instanceof SupabaseError || (error instanceof Error && error.name === "SupabaseError")) {
			const status =
				error instanceof SupabaseError && error.status >= 400 && error.status < 600
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
