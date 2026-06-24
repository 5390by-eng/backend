const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "deepseek/deepseek-v4-pro";

const SYSTEM_PROMPT = `You are a task decomposition assistant. Given a large task, break it into smaller actionable subtasks.

Return ONLY a valid JSON array. Each element must be an object with a single "task" key containing a string describing one subtask.

Example format:
[{"task":"Определить требования к проекту"},{"task":"Создать wireframes"}]

Rules:
- Return 3-10 subtasks depending on complexity
- Each task should be specific and actionable
- All task descriptions must be written in Russian only
- No markdown, no explanations, only the JSON array`;

export interface TaskItem {
	task: string;
}

export class OpenRouterError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
		this.name = "OpenRouterError";
	}
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
	error?: {
		message?: string;
	};
}

function parseTasks(content: string): TaskItem[] {
	let parsed: unknown;

	try {
		parsed = JSON.parse(content);
	} catch {
		const match = content.match(/\[[\s\S]*\]/);
		if (!match) {
			throw new OpenRouterError("Invalid task decomposition format from model", 502);
		}

		try {
			parsed = JSON.parse(match[0]);
		} catch {
			throw new OpenRouterError("Invalid task decomposition format from model", 502);
		}
	}

	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new OpenRouterError("Invalid task decomposition format from model", 502);
	}

	for (const item of parsed) {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof (item as TaskItem).task !== "string" ||
			(item as TaskItem).task.trim() === ""
		) {
			throw new OpenRouterError("Invalid task decomposition format from model", 502);
		}
	}

	return parsed as TaskItem[];
}

export async function decomposeTask(apiKey: string, message: string): Promise<TaskItem[]> {
	const response = await fetch(OPENROUTER_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://backend.workers.dev",
			"X-Title": "Backend Chat",
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: message },
			],
		}),
	});

	const data = (await response.json()) as ChatCompletionResponse;

	if (!response.ok) {
		throw new OpenRouterError(
			data.error?.message ?? "OpenRouter request failed",
			response.status,
		);
	}

	const content = data.choices?.[0]?.message?.content;
	if (!content) {
		throw new OpenRouterError("Empty response from OpenRouter", 502);
	}

	return parseTasks(content);
}
