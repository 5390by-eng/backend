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
