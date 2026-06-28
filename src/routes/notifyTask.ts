import { notifyUserAboutTaskByUserId } from "../services/taskNotifications";
import { isValidUuid, resolveSupabaseApiKey, SupabaseError } from "../services/supabase";
import { TelegramError } from "../services/telegram";

interface NotifyTaskRequestBody {
	userId?: unknown;
	task?: unknown;
	boardTitle?: unknown;
}

export async function handleNotifyTask(request: Request, env: Env): Promise<Response> {
	let body: NotifyTaskRequestBody;

	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (typeof body.userId !== "string" || !isValidUuid(body.userId)) {
		return Response.json(
			{ error: "Field 'userId' is required and must be a valid UUID" },
			{ status: 400 },
		);
	}

	if (typeof body.task !== "string" || body.task.trim() === "") {
		return Response.json(
			{ error: "Field 'task' is required and must be a non-empty string" },
			{ status: 400 },
		);
	}

	if (body.boardTitle !== undefined && typeof body.boardTitle !== "string") {
		return Response.json({ error: "Field 'boardTitle' must be a string when provided" }, { status: 400 });
	}

	if (!env.TELEGRAM_BOT_TOKEN) {
		return Response.json({ error: "TELEGRAM_BOT_TOKEN is not configured" }, { status: 500 });
	}

	if (!env.SUPABASE_URL) {
		return Response.json({ error: "Supabase is not configured" }, { status: 500 });
	}

	let supabaseConfig: { url: string; apiKey: string };
	try {
		supabaseConfig = {
			url: env.SUPABASE_URL.trim(),
			apiKey: resolveSupabaseApiKey(env),
		};
	} catch (error) {
		if (error instanceof SupabaseError) {
			return Response.json({ error: error.message }, { status: 500 });
		}

		return Response.json({ error: "Invalid Supabase configuration" }, { status: 500 });
	}

	const boardTitle =
		typeof body.boardTitle === "string" && body.boardTitle.trim() !== ""
			? body.boardTitle.trim()
			: "Доска";

	try {
		const result = await notifyUserAboutTaskByUserId(
			supabaseConfig,
			env.TELEGRAM_BOT_TOKEN,
			body.userId,
			boardTitle,
			body.task.trim(),
		);

		return Response.json(result);
	} catch (error) {
		console.error("handleNotifyTask failed:", error);

		if (error instanceof SupabaseError || (error instanceof Error && error.name === "SupabaseError")) {
			const status =
				error instanceof SupabaseError && error.status >= 400 && error.status < 600
					? error.status
					: 502;
			return Response.json({ error: error.message }, { status });
		}

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
