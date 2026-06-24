import { decomposeTask, OpenRouterError } from "../services/openrouter";

interface ChatRequestBody {
	message?: unknown;
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

	if (!env.OPENROUTER_API_KEY) {
		return Response.json({ error: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
	}

	try {
		const tasks = await decomposeTask(env.OPENROUTER_API_KEY, body.message.trim());
		return Response.json(tasks);
	} catch (error) {
		if (error instanceof OpenRouterError) {
			return Response.json({ error: error.message }, { status: 502 });
		}

		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
