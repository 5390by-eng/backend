import { DifyError, listNormalizedKnowledgeBases } from "../services/dify";

function handleDifyError(error: unknown): Response {
	if (error instanceof DifyError) {
		const status = error.status >= 400 && error.status < 600 ? error.status : 502;
		return Response.json({ error: error.message }, { status });
	}

	if (error instanceof Error) {
		return Response.json({ error: error.message }, { status: 500 });
	}

	return Response.json({ error: "Dify request failed" }, { status: 500 });
}

export async function handleKnowledgeBases(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "GET") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	if (!env.DIFY_API_KEY?.trim()) {
		return Response.json({ error: "DIFY_API_KEY is not configured" }, { status: 500 });
	}

	try {
		const knowledgeBases = await listNormalizedKnowledgeBases(env);
		return Response.json(knowledgeBases);
	} catch (error) {
		return handleDifyError(error);
	}
}
