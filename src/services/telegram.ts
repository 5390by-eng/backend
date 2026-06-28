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

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

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
	const chatId = update.message?.chat.id;
	return typeof chatId === "number" ? chatId : null;
}

export async function sendMessage(botToken: string, chatId: number, text: string): Promise<void> {
	const response = await fetch(getTelegramApiUrl(botToken, "sendMessage"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text }),
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
