const DEFAULT_DIFY_API_BASE_URL = "https://api.dify.ai/v1";
const DATASETS_PAGE_LIMIT = 100;

export interface DifyDataset {
	id: string;
	name: string;
	description: string | null;
	provider: string;
	permission: string;
	data_source_type: string | null;
	indexing_technique: string | null;
	app_count: number;
	document_count: number;
	word_count: number;
	created_by: string;
	created_at: number;
	updated_by: string;
	updated_at: number;
	embedding_model: string | null;
	embedding_model_provider: string | null;
	embedding_available: boolean | null;
	retrieval_model_dict: Record<string, unknown> | null;
	tags: Array<Record<string, unknown>>;
	doc_form: string | null;
}

export interface DifyDatasetListResponse {
	data: DifyDataset[];
	has_more: boolean;
	limit: number;
	total: number;
	page: number;
}

export interface KnowledgeBase {
	id: string;
	name: string;
	description: string | null;
	documentCount: number;
	wordCount: number;
	permission: string;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeBasesResponse {
	items: KnowledgeBase[];
	total: number;
}

export class DifyError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
		this.name = "DifyError";
	}
}

function resolveDifyApiBaseUrl(env: Env): string {
	const configured = env.DIFY_API_BASE_URL?.trim();
	if (configured) {
		return configured.replace(/\/+$/, "");
	}

	return DEFAULT_DIFY_API_BASE_URL;
}

function toIsoTimestamp(value: number): string {
	const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
	return new Date(milliseconds).toISOString();
}

function parseDatasetListResponse(rawBody: string): DifyDatasetListResponse {
	let parsed: unknown;

	try {
		parsed = rawBody ? JSON.parse(rawBody) : {};
	} catch {
		throw new DifyError("Invalid response from Dify", 502);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray((parsed as DifyDatasetListResponse).data)
	) {
		throw new DifyError("Invalid response from Dify", 502);
	}

	const payload = parsed as DifyDatasetListResponse;

	return {
		data: payload.data,
		has_more: Boolean(payload.has_more),
		limit: typeof payload.limit === "number" ? payload.limit : DATASETS_PAGE_LIMIT,
		total: typeof payload.total === "number" ? payload.total : payload.data.length,
		page: typeof payload.page === "number" ? payload.page : 1,
	};
}

async function fetchDatasetPage(env: Env, page: number): Promise<DifyDatasetListResponse> {
	const apiKey = env.DIFY_API_KEY?.trim();
	if (!apiKey) {
		throw new DifyError("DIFY_API_KEY is not configured", 500);
	}

	const baseUrl = resolveDifyApiBaseUrl(env);
	const url = new URL(`${baseUrl}/datasets`);
	url.searchParams.set("page", String(page));
	url.searchParams.set("limit", String(DATASETS_PAGE_LIMIT));

	const response = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	});

	const rawBody = await response.text();

	if (!response.ok) {
		let message = "Dify request failed";

		try {
			const errorPayload = rawBody ? (JSON.parse(rawBody) as { message?: string }) : {};
			if (typeof errorPayload.message === "string" && errorPayload.message.trim()) {
				message = errorPayload.message;
			}
		} catch {
			// keep default message
		}

		throw new DifyError(message, response.status >= 400 && response.status < 600 ? response.status : 502);
	}

	return parseDatasetListResponse(rawBody);
}

export function normalizeKnowledgeBases(datasets: DifyDataset[]): KnowledgeBasesResponse {
	const items = datasets.map((dataset) => ({
		id: dataset.id,
		name: dataset.name,
		description: dataset.description,
		documentCount: dataset.document_count,
		wordCount: dataset.word_count,
		permission: dataset.permission,
		createdAt: toIsoTimestamp(dataset.created_at),
		updatedAt: toIsoTimestamp(dataset.updated_at),
	}));

	return {
		items,
		total: items.length,
	};
}

export async function listAllKnowledgeBases(env: Env): Promise<DifyDatasetListResponse> {
	const aggregated: DifyDataset[] = [];
	let page = 1;
	let hasMore = true;
	let total = 0;
	let limit = DATASETS_PAGE_LIMIT;

	while (hasMore) {
		const pageResult = await fetchDatasetPage(env, page);
		aggregated.push(...pageResult.data);
		total = pageResult.total;
		limit = pageResult.limit;
		hasMore = pageResult.has_more;

		if (!hasMore) {
			break;
		}

		page += 1;
	}

	return {
		data: aggregated,
		has_more: false,
		limit,
		total,
		page: 1,
	};
}

export async function listNormalizedKnowledgeBases(env: Env): Promise<KnowledgeBasesResponse> {
	const result = await listAllKnowledgeBases(env);
	return normalizeKnowledgeBases(result.data);
}
