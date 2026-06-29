import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const testEnv = {
	...env,
	DIFY_API_KEY: "test-dify-api-key",
} as Env;

function createKnowledgeBasesRequest(method = "GET"): Request {
	return new IncomingRequest("http://example.com/knowledge-bases", { method });
}

function createDataset(id: string, name: string) {
	return {
		id,
		name,
		description: null,
		provider: "vendor",
		permission: "only_me",
		data_source_type: "upload_file",
		indexing_technique: "high_quality",
		app_count: 0,
		document_count: 1,
		word_count: 100,
		created_by: "creator",
		created_at: 1,
		updated_by: "creator",
		updated_at: 1,
		embedding_model: null,
		embedding_model_provider: null,
		embedding_available: true,
		retrieval_model_dict: null,
		tags: [],
		doc_form: null,
	};
}

function difyDatasetsResponse(
	page: number,
	options: {
		data?: ReturnType<typeof createDataset>[];
		hasMore?: boolean;
		total?: number;
	} = {},
): Response {
	const data = options.data ?? [createDataset(`dataset-${page}`, `Dataset ${page}`)];

	return new Response(
		JSON.stringify({
			data,
			has_more: options.hasMore ?? false,
			limit: 100,
			total: options.total ?? data.length,
			page,
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function resolveFetchUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("GET /knowledge-bases", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns knowledge bases without authentication", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = resolveFetchUrl(input);

			if (url.includes("/datasets?page=1")) {
				return difyDatasetsResponse(1, {
					data: [createDataset("dataset-1", "First")],
				});
			}

			return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createKnowledgeBasesRequest();
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: Array<{ id: string; name: string }>;
			total: number;
		};

		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({ id: "dataset-1", name: "First" });
		expect(body.total).toBe(1);
	});

	it("returns 405 for non-GET methods", async () => {
		const request = createKnowledgeBasesRequest("POST");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({ error: "Method not allowed" });
	});

	it("returns 500 when DIFY_API_KEY is not configured", async () => {
		const request = createKnowledgeBasesRequest();
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "DIFY_API_KEY is not configured" });
	});

	it("aggregates all Dify dataset pages into normalized response", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = resolveFetchUrl(input);

			if (url.includes("/datasets?page=1")) {
				return difyDatasetsResponse(1, {
					data: [createDataset("dataset-1", "First"), createDataset("dataset-2", "Second")],
					hasMore: true,
					total: 3,
				});
			}

			if (url.includes("/datasets?page=2")) {
				return difyDatasetsResponse(2, {
					data: [createDataset("dataset-3", "Third")],
					hasMore: false,
					total: 3,
				});
			}

			return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createKnowledgeBasesRequest();
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: Array<{ id: string; name: string }>;
			total: number;
		};

		expect(body.items).toHaveLength(3);
		expect(body.items.map((item) => item.id)).toEqual(["dataset-1", "dataset-2", "dataset-3"]);
		expect(body.total).toBe(3);
	});

	it("returns upstream Dify errors", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = resolveFetchUrl(input);

			if (url.includes("/datasets")) {
				return new Response(JSON.stringify({ message: "Invalid API key" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response(JSON.stringify({ message: "Unexpected request" }), { status: 500 });
		});

		const request = createKnowledgeBasesRequest();
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid API key" });
	});
});
