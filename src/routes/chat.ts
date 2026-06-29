import { getAuthenticatedUser } from "../lib/auth";
import { createTasksFromMessage, OpenRouterError, SupabaseError } from "../services/taskCreation";
import { notifyAssigneesAboutNewTasks } from "../services/taskNotifications";
import { consumeAiRequest } from "../services/billing";
import { getBoardTasks, isValidUuid, resolveSupabaseApiKey } from "../services/supabase";

interface ChatRequestBody {
	message?: unknown;
	boardId?: unknown;
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
	let body: ChatRequestBody;

	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (typeof body.message !== "string" || body.message.trim() === "") {
		return Response.json({ error: "Field 'message' is required and must be a non-empty string" }, { status: 400 });
	}

	if (typeof body.boardId !== "string" || !isValidUuid(body.boardId)) {
		return Response.json({ error: "Field 'boardId' is required and must be a valid UUID" }, { status: 400 });
	}

	if (!env.OPENROUTER_API_KEY) {
		return Response.json({ error: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
	}

	if (!env.SUPABASE_URL) {
		return Response.json({ error: "Supabase is not configured" }, { status: 500 });
	}

	const user = await getAuthenticatedUser(request, env);
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
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

	const boardId = body.boardId;

	try {
		try {
			await consumeAiRequest(env, user.id);
		} catch (error) {
			if (error instanceof SupabaseError) {
				const message = error.message.toLowerCase();
				if (message.includes("quota exceeded") || message.includes("ai quota")) {
					return Response.json(
						{
							error: "AI request quota exceeded. Purchase more requests on the Billing page.",
							code: "AI_QUOTA_EXCEEDED",
						},
						{ status: 403 },
					);
				}
			}

			throw error;
		}

		const createdTasks = await createTasksFromMessage(
			supabaseConfig,
			env.OPENROUTER_API_KEY,
			boardId,
			body.message.trim(),
		);

		if (env.TELEGRAM_BOT_TOKEN) {
			const { boardTitle } = await getBoardTasks(supabaseConfig, boardId);
			await notifyAssigneesAboutNewTasks(
				supabaseConfig,
				env.TELEGRAM_BOT_TOKEN,
				boardTitle,
				createdTasks,
			);
		}

		return Response.json(createdTasks);
	} catch (error) {
		console.error("handleChat failed:", error);

		if (error instanceof OpenRouterError || (error instanceof Error && error.name === "OpenRouterError")) {
			return Response.json({ error: error.message }, { status: 502 });
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
