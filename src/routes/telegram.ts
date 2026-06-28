import { createTasksFromMessage, OpenRouterError, SupabaseError } from "../services/taskCreation";
import { notifyAssigneesAboutNewTasks } from "../services/taskNotifications";
import {
	answerCallbackQuery,
	buildBoardsInlineKeyboard,
	buildCreateBoardsInlineKeyboard,
	buildStartKeyboard,
	CREATE_TASKS_PROMPT_MESSAGE,
	extractChatIdFromUpdate,
	extractUsernameFromUpdate,
	formatCreatedTasksList,
	formatTasksList,
	isCreateTasksCallback,
	isGetBoardsCallback,
	isStartCommand,
	isToggleNotificationsCallback,
	isValidWebhookSecret,
	NOTIFY_SUBSCRIBED_MESSAGE,
	NOTIFY_UNSUBSCRIBED_MESSAGE,
	NOTIFY_USERNAME_REQUIRED_MESSAGE,
	parseBoardCallbackData,
	parseCreateBoardCallbackData,
	SELECT_BOARD_FOR_TASKS_MESSAGE,
	SELECT_BOARD_MESSAGE,
	sendMessage,
	START_KEYBOARD,
	START_MESSAGE,
	TelegramError,
	type TelegramUpdate,
} from "../services/telegram";
import {
	consumeTelegramPending,
	getAllBoards,
	getBoardTasks,
	getTelegramSubscription,
	isValidUuid,
	resolveSupabaseApiKey,
	saveTelegramPendingText,
	setTelegramSubscription,
	startTelegramCreateFlow,
	type SupabaseConfig,
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
): Promise<SupabaseConfig | null> {
	if (!env.SUPABASE_URL) {
		await sendMessage(botToken, chatId, "Supabase не настроен.", {
			replyMarkup: START_KEYBOARD,
		});
		return null;
	}

	try {
		return resolveSupabaseConfig(env);
	} catch (error) {
		const message =
			error instanceof SupabaseError ? error.message : "Некорректная конфигурация Supabase.";
		await sendMessage(botToken, chatId, message, { replyMarkup: START_KEYBOARD });
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
			replyMarkup: START_KEYBOARD,
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

async function handleCreateTasksStart(
	env: Env,
	botToken: string,
	chatId: number,
	callbackQueryId: string,
): Promise<void> {
	await answerCallbackQuery(botToken, callbackQueryId);

	const supabaseConfig = await resolveSupabaseConfigOrReply(env, botToken, chatId);
	if (!supabaseConfig) {
		return;
	}

	await startTelegramCreateFlow(supabaseConfig, chatId);
	await sendMessage(botToken, chatId, CREATE_TASKS_PROMPT_MESSAGE);
}

async function handleCreateTasksText(
	env: Env,
	botToken: string,
	chatId: number,
	text: string,
): Promise<void> {
	const supabaseConfig = await resolveSupabaseConfigOrReply(env, botToken, chatId);
	if (!supabaseConfig) {
		return;
	}

	let pendingId: string;
	try {
		pendingId = await saveTelegramPendingText(supabaseConfig, chatId, text.trim());
	} catch (error) {
		if (error instanceof SupabaseError && error.message.includes("No active pending request")) {
			return;
		}

		throw error;
	}

	const boards = await getAllBoards(supabaseConfig);
	if (boards.length === 0) {
		await sendMessage(botToken, chatId, "Досок пока нет. Сначала создайте доску в приложении.");
		return;
	}

	await sendMessage(botToken, chatId, SELECT_BOARD_FOR_TASKS_MESSAGE, {
		replyMarkup: buildCreateBoardsInlineKeyboard(pendingId, boards),
	});
}

async function handleCreateBoardSelection(
	env: Env,
	botToken: string,
	chatId: number,
	pendingId: string,
	boardIndex: number,
	callbackQueryId: string,
): Promise<void> {
	await answerCallbackQuery(botToken, callbackQueryId);

	if (!env.OPENROUTER_API_KEY) {
		await sendMessage(botToken, chatId, "OpenRouter не настроен.");
		return;
	}

	const supabaseConfig = await resolveSupabaseConfigOrReply(env, botToken, chatId);
	if (!supabaseConfig) {
		return;
	}

	const boards = await getAllBoards(supabaseConfig);
	const board = boards[boardIndex];
	if (!board) {
		await sendMessage(botToken, chatId, "Доска не найдена. Начните создание задач заново.", {
			replyMarkup: START_KEYBOARD,
		});
		return;
	}

	const pending = await consumeTelegramPending(supabaseConfig, pendingId, chatId);
	if (!pending) {
		await sendMessage(botToken, chatId, "Запрос устарел или уже использован. Нажмите «Создание задач» снова.", {
			replyMarkup: START_KEYBOARD,
		});
		return;
	}

	const createdTasks = await createTasksFromMessage(
		supabaseConfig,
		env.OPENROUTER_API_KEY,
		board.id,
		pending.messageText,
	);

	await notifyAssigneesAboutNewTasks(
		supabaseConfig,
		env.TELEGRAM_BOT_TOKEN,
		board.title,
		createdTasks,
	);

	await sendMessage(
		botToken,
		chatId,
		formatCreatedTasksList(board.title, createdTasks),
	);
}

async function handleToggleNotifications(
	env: Env,
	botToken: string,
	chatId: number,
	update: TelegramUpdate,
	callbackQueryId: string,
): Promise<void> {
	await answerCallbackQuery(botToken, callbackQueryId);

	const supabaseConfig = await resolveSupabaseConfigOrReply(env, botToken, chatId);
	if (!supabaseConfig) {
		return;
	}

	const currentSubscription = await getTelegramSubscription(supabaseConfig, chatId);
	const nextSubscribed = !currentSubscription.isSubscribed;

	if (nextSubscribed) {
		const username = extractUsernameFromUpdate(update);
		if (!username) {
			await sendMessage(botToken, chatId, NOTIFY_USERNAME_REQUIRED_MESSAGE, {
				replyMarkup: buildStartKeyboard(false),
			});
			return;
		}

		await setTelegramSubscription(supabaseConfig, chatId, username, true);
		await sendMessage(
			botToken,
			chatId,
			NOTIFY_SUBSCRIBED_MESSAGE.replace("{username}", username),
			{ replyMarkup: buildStartKeyboard(true) },
		);
		return;
	}

	if (currentSubscription.username) {
		await setTelegramSubscription(supabaseConfig, chatId, currentSubscription.username, false);
	}

	await sendMessage(botToken, chatId, NOTIFY_UNSUBSCRIBED_MESSAGE, {
		replyMarkup: buildStartKeyboard(false),
	});
}

async function handleStart(env: Env, botToken: string, chatId: number): Promise<void> {
	const supabaseConfig = await resolveSupabaseConfigOrReply(env, botToken, chatId);
	if (!supabaseConfig) {
		return;
	}

	const subscription = await getTelegramSubscription(supabaseConfig, chatId);
	await sendMessage(botToken, chatId, START_MESSAGE, {
		replyMarkup: buildStartKeyboard(subscription.isSubscribed),
	});
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
	const createBoardSelection = parseCreateBoardCallbackData(callbackData);

	try {
		if (createBoardSelection && update.callback_query) {
			await handleCreateBoardSelection(
				env,
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				createBoardSelection.pendingId,
				createBoardSelection.boardIndex,
				update.callback_query.id,
			);
			return new Response("ok", { status: 200 });
		}

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

		if (isCreateTasksCallback(callbackData) && update.callback_query) {
			await handleCreateTasksStart(env, env.TELEGRAM_BOT_TOKEN, chatId, update.callback_query.id);
			return new Response("ok", { status: 200 });
		}

		if (isGetBoardsCallback(callbackData) && update.callback_query) {
			await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, update.callback_query.id);
			await handleGetBoards(env, env.TELEGRAM_BOT_TOKEN, chatId);
			return new Response("ok", { status: 200 });
		}

		if (isToggleNotificationsCallback(callbackData) && update.callback_query) {
			await handleToggleNotifications(
				env,
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				update,
				update.callback_query.id,
			);
			return new Response("ok", { status: 200 });
		}

		if (isStartCommand(text)) {
			await handleStart(env, env.TELEGRAM_BOT_TOKEN, chatId);
			return new Response("ok", { status: 200 });
		}

		if (typeof text === "string" && text.trim() !== "" && !text.trim().startsWith("/")) {
			await handleCreateTasksText(env, env.TELEGRAM_BOT_TOKEN, chatId, text);
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

		if (error instanceof OpenRouterError || (error instanceof Error && error.name === "OpenRouterError")) {
			if (chatId !== null) {
				await notifyCallbackError(
					env.TELEGRAM_BOT_TOKEN,
					chatId,
					"Не удалось разбить задачу. Попробуйте ещё раз.",
				);
			}
			return Response.json({ error: error.message }, { status: 502 });
		}

		if (error instanceof SupabaseError || (error instanceof Error && error.name === "SupabaseError")) {
			const status =
				error instanceof SupabaseError && error.status >= 400 && error.status < 600
					? error.status
					: 502;

			if (chatId !== null && update.callback_query) {
				await notifyCallbackError(env.TELEGRAM_BOT_TOKEN, chatId, "Не удалось выполнить действие. Попробуйте ещё раз.");
			}

			return Response.json({ error: error.message }, { status });
		}

		if (error instanceof Error) {
			return Response.json({ error: error.message }, { status: 500 });
		}

		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
