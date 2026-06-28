const TELEGRAM_API_BASE = "https://api.telegram.org";

export class TelegramError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
		this.name = "TelegramError";
	}
}

export interface TelegramChat {
	id: number;
}

export interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	text?: string;
}

export interface TelegramUser {
	id: number;
}

export interface TelegramCallbackQuery {
	id: string;
	data?: string;
	from?: TelegramUser;
	message?: TelegramMessage;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageOptions {
	replyMarkup?: InlineKeyboardMarkup;
}

export const GET_BOARDS_BUTTON_TEXT = "Получить Boards";
export const GET_BOARDS_CALLBACK = "get_boards";
export const BOARD_CALLBACK_PREFIX = "board:";
export const SELECT_BOARD_MESSAGE = "Выберите доску:";

export const GET_BOARDS_KEYBOARD: InlineKeyboardMarkup = {
	inline_keyboard: [[{ text: GET_BOARDS_BUTTON_TEXT, callback_data: GET_BOARDS_CALLBACK }]],
};

export const GET_BOARDS_INLINE_KEYBOARD = GET_BOARDS_KEYBOARD;

export const START_MESSAGE = "Привет! Нажмите кнопку ниже, чтобы получить список досок.";

interface TelegramApiResponse {
	ok?: boolean;
	description?: string;
}

function getTelegramApiUrl(botToken: string, method: string): string {
	return `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
}

export function isValidWebhookSecret(provided: string | null, expected: string): boolean {
	if (!provided || !expected) {
		return false;
	}

	if (provided.length !== expected.length) {
		return false;
	}

	let mismatch = 0;
	for (let index = 0; index < expected.length; index += 1) {
		mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
	}

	return mismatch === 0;
}

export function extractChatIdFromUpdate(update: TelegramUpdate): number | null {
	const chatId =
		update.message?.chat.id ??
		update.callback_query?.message?.chat.id ??
		update.callback_query?.from?.id;
	return typeof chatId === "number" ? chatId : null;
}

export function isStartCommand(text: string | undefined): boolean {
	return text?.trim().split(/\s+/)[0] === "/start";
}

export function isGetBoardsCallback(data: string | undefined): boolean {
	return data === GET_BOARDS_CALLBACK;
}

export function buildBoardCallbackData(boardId: string): string {
	return `${BOARD_CALLBACK_PREFIX}${boardId}`;
}

export function parseBoardCallbackData(data: string | undefined): string | null {
	if (!data?.startsWith(BOARD_CALLBACK_PREFIX)) {
		return null;
	}

	const boardId = data.slice(BOARD_CALLBACK_PREFIX.length);
	return boardId.length > 0 ? boardId : null;
}

export function buildBoardsInlineKeyboard(
	boards: Array<{ id: string; title: string }>,
): InlineKeyboardMarkup {
	return {
		inline_keyboard: boards.map((board) => [
			{ text: board.title, callback_data: buildBoardCallbackData(board.id) },
		]),
	};
}

export function formatTasksList(
	boardTitle: string,
	tasks: Array<{ title: string; status: string }>,
): string {
	if (tasks.length === 0) {
		return `На доске «${boardTitle}» задач пока нет.`;
	}

	const lines = tasks.map((task, index) => `${index + 1}. ${task.title} (${task.status})`);
	return `Задачи на доске «${boardTitle}»:\n\n${lines.join("\n\n")}`;
}

async function callTelegramApi(botToken: string, method: string, body: Record<string, unknown>): Promise<void> {
	const response = await fetch(getTelegramApiUrl(botToken, method), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	const rawBody = await response.text();
	let data: TelegramApiResponse;

	try {
		data = rawBody ? (JSON.parse(rawBody) as TelegramApiResponse) : {};
	} catch {
		throw new TelegramError("Invalid response from Telegram", 502);
	}

	if (!response.ok || data.ok === false) {
		throw new TelegramError(data.description ?? "Telegram request failed", response.status);
	}
}

export async function sendMessage(
	botToken: string,
	chatId: number,
	text: string,
	options?: SendMessageOptions,
): Promise<void> {
	const body: Record<string, unknown> = { chat_id: chatId, text };
	if (options?.replyMarkup) {
		body.reply_markup = options.replyMarkup;
	}

	await callTelegramApi(botToken, "sendMessage", body);
}

export async function answerCallbackQuery(botToken: string, callbackQueryId: string): Promise<void> {
	await callTelegramApi(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId });
}
