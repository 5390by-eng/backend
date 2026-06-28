const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
	return UUID_REGEX.test(value);
}

export interface BoardMember {
	id: string;
	name: string;
	email: string;
	role: string;
	teamRole: string | null;
	boardRole: string;
}

export interface Board {
	id: string;
	title: string;
	description: string;
}

export interface BoardTask {
	id: string;
	title: string;
	status: string;
	priority: string;
}

export interface BoardTasksResult {
	boardTitle: string;
	tasks: BoardTask[];
}

export interface CreatedTask {
	id: string;
	title: string;
	boardId: string;
	status: string;
	priority: string;
	assignee: {
		id: string;
		name: string;
		email: string;
		role: string;
		teamRole: string | null;
	};
}

export interface SupabaseConfig {
	url: string;
	apiKey: string;
}

export class SupabaseError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
		this.name = "SupabaseError";
	}
}

export function resolveSupabaseApiKey(env: Env): string {
	const candidates = [env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ANON_KEY];

	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}

		const cleaned = candidate.trim();
		if (
			cleaned.startsWith("eyJ") ||
			cleaned.startsWith("sb_secret_") ||
			cleaned.startsWith("sb_publishable_")
		) {
			return cleaned;
		}
	}

	throw new SupabaseError(
		"Supabase API key is not configured. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.",
		500,
	);
}

function normalizeSupabaseUrl(url: string): string {
	const cleaned = url.trim().replace(/[\u0000-\u001F\u007F]/g, "").replace(/\/+$/, "");

	try {
		const parsed = new URL(cleaned);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new SupabaseError("Invalid SUPABASE_URL configuration", 500);
		}

		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		throw new SupabaseError(
			"Invalid SUPABASE_URL configuration. Expected format: https://your-project.supabase.co",
			500,
		);
	}
}

function buildSupabaseHeaders(key: string, extra?: HeadersInit): HeadersInit {
	const headers: Record<string, string> = {
		apikey: key,
		"Content-Type": "application/json",
	};

	if (key.startsWith("eyJ")) {
		headers.Authorization = `Bearer ${key}`;
	}

	return {
		...headers,
		...(extra ?? {}),
	};
}

async function supabaseRpc<T>(config: SupabaseConfig, functionName: string, body: unknown): Promise<T> {
	const baseUrl = normalizeSupabaseUrl(config.url);
	const response = await fetch(`${baseUrl}/rest/v1/rpc/${functionName}`, {
		method: "POST",
		headers: buildSupabaseHeaders(config.apiKey),
		body: JSON.stringify(body),
	});

	const errorText = await response.text();

	if (!response.ok) {
		let message = "Supabase request failed";

		try {
			const parsed = errorText
				? (JSON.parse(errorText) as {
						message?: string;
						hint?: string;
						error?: string;
						error_description?: string;
					})
				: {};
			message =
				parsed.message ??
				parsed.hint ??
				parsed.error_description ??
				parsed.error ??
				message;
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

	try {
		return JSON.parse(errorText) as T;
	} catch {
		throw new SupabaseError("Invalid JSON response from Supabase", response.status);
	}
}

export async function getAllBoards(config: SupabaseConfig): Promise<Board[]> {
	const boards = await supabaseRpc<Board[]>(config, "chat_list_boards", {});
	return Array.isArray(boards) ? boards : [];
}

export async function getBoardTasks(config: SupabaseConfig, boardId: string): Promise<BoardTasksResult> {
	const result = await supabaseRpc<{
		board_title?: string | null;
		tasks?: BoardTask[] | null;
	}>(config, "chat_board_tasks", { p_board_id: boardId });

	return {
		boardTitle: result?.board_title ?? "Доска",
		tasks: Array.isArray(result?.tasks) ? result.tasks : [],
	};
}

export async function boardExists(config: SupabaseConfig, boardId: string): Promise<boolean> {
	return supabaseRpc<boolean>(config, "chat_board_exists", { p_board_id: boardId });
}

export async function getBoardMembers(
	config: SupabaseConfig,
	boardId: string,
): Promise<BoardMember[]> {
	const members = await supabaseRpc<BoardMember[]>(config, "chat_board_members", {
		p_board_id: boardId,
	});

	return Array.isArray(members) ? members : [];
}

export async function createTasks(
	config: SupabaseConfig,
	boardId: string,
	tasks: Array<{ title: string; assigneeId: string; position: number; assignee: BoardMember }>,
): Promise<CreatedTask[]> {
	const created = await supabaseRpc<CreatedTask[]>(config, "chat_create_tasks", {
		p_board_id: boardId,
		p_tasks: tasks.map((task) => ({
			title: task.title,
			assignee_id: task.assigneeId,
			position: task.position,
		})),
	});

	return Array.isArray(created) ? created : [];
}

export interface PendingTelegramRequest {
	id: string;
	chatId: number;
	messageText: string;
	status: string;
}

export async function startTelegramCreateFlow(
	config: SupabaseConfig,
	chatId: number,
): Promise<string> {
	const pendingId = await supabaseRpc<string>(config, "chat_telegram_start_create", {
		p_chat_id: chatId,
	});

	if (typeof pendingId !== "string" || !isValidUuid(pendingId)) {
		throw new SupabaseError("Failed to start Telegram create flow", 502);
	}

	return pendingId;
}

export async function saveTelegramPendingText(
	config: SupabaseConfig,
	chatId: number,
	messageText: string,
): Promise<string> {
	const pendingId = await supabaseRpc<string>(config, "chat_telegram_save_pending_text", {
		p_chat_id: chatId,
		p_message_text: messageText,
	});

	if (typeof pendingId !== "string" || !isValidUuid(pendingId)) {
		throw new SupabaseError("Failed to save pending Telegram request", 502);
	}

	return pendingId;
}

export async function consumeTelegramPending(
	config: SupabaseConfig,
	pendingId: string,
	chatId: number,
): Promise<PendingTelegramRequest | null> {
	const result = await supabaseRpc<{
		id?: string;
		chatId?: number;
		messageText?: string;
		status?: string;
	} | null>(config, "chat_telegram_consume_pending", {
		p_pending_id: pendingId,
		p_chat_id: chatId,
	});

	if (!result?.id || typeof result.messageText !== "string") {
		return null;
	}

	return {
		id: result.id,
		chatId: result.chatId ?? chatId,
		messageText: result.messageText,
		status: result.status ?? "awaiting_board",
	};
}

export interface TelegramSubscription {
	isSubscribed: boolean;
	username: string | null;
}

export interface TelegramSubscriber {
	chatId: number;
	username: string;
}

export async function getTelegramSubscription(
	config: SupabaseConfig,
	chatId: number,
): Promise<TelegramSubscription> {
	const result = await supabaseRpc<{
		isSubscribed?: boolean;
		username?: string | null;
	}>(config, "chat_telegram_get_subscription", {
		p_chat_id: chatId,
	});

	return {
		isSubscribed: result?.isSubscribed === true,
		username: typeof result?.username === "string" ? result.username : null,
	};
}

export async function setTelegramSubscription(
	config: SupabaseConfig,
	chatId: number,
	username: string,
	isSubscribed: boolean,
): Promise<TelegramSubscription> {
	const result = await supabaseRpc<{
		isSubscribed?: boolean;
		username?: string;
	}>(config, "chat_telegram_set_subscription", {
		p_chat_id: chatId,
		p_username: username,
		p_subscribed: isSubscribed,
	});

	return {
		isSubscribed: result?.isSubscribed === true,
		username: typeof result?.username === "string" ? result.username : username,
	};
}

export async function findTelegramSubscribersByAssigneeNames(
	config: SupabaseConfig,
	assigneeNames: string[],
): Promise<TelegramSubscriber[]> {
	if (assigneeNames.length === 0) {
		return [];
	}

	const subscribers = await supabaseRpc<Array<{ chat_id?: number; username?: string }>>(
		config,
		"chat_telegram_find_subscribers",
		{
			p_assignee_names: assigneeNames,
		},
	);

	if (!Array.isArray(subscribers)) {
		return [];
	}

	return subscribers
		.filter(
			(subscriber): subscriber is { chat_id: number; username: string } =>
				typeof subscriber.chat_id === "number" && typeof subscriber.username === "string",
		)
		.map((subscriber) => ({
			chatId: subscriber.chat_id,
			username: subscriber.username,
		}));
}

export interface UserTelegramLookup {
	telegramUsername: string | null;
	name: string;
}

export async function getUserTelegramLookup(
	config: SupabaseConfig,
	userId: string,
): Promise<UserTelegramLookup | null> {
	const result = await supabaseRpc<{
		telegramUsername?: string | null;
		name?: string | null;
	} | null>(config, "chat_user_telegram_lookup", {
		p_user_id: userId,
	});

	if (!result || typeof result.name !== "string") {
		return null;
	}

	return {
		telegramUsername:
			typeof result.telegramUsername === "string" && result.telegramUsername.trim() !== ""
				? result.telegramUsername
				: null,
		name: result.name,
	};
}
