const DEFAULT_ALLOWED_ORIGINS = [
	"http://localhost:5173",
	"http://localhost:3000",
	"http://127.0.0.1:5173",
];

export function getAllowedOrigins(env: Env): string[] {
	if (env.ALLOWED_ORIGINS) {
		return env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
	}

	return DEFAULT_ALLOWED_ORIGINS;
}

export function isOriginAllowed(origin: string, allowed: string[]): boolean {
	return allowed.includes(origin);
}

export function corsHeaders(origin: string): Headers {
	const headers = new Headers();
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
	headers.set("Access-Control-Allow-Headers", "Content-Type");
	headers.set("Access-Control-Max-Age", "86400");
	return headers;
}

export function withCors(response: Response, request: Request, allowed: string[]): Response {
	const origin = request.headers.get("Origin");
	if (!origin || !isOriginAllowed(origin, allowed)) {
		return response;
	}

	const cors = corsHeaders(origin);
	const headers = new Headers(response.headers);
	for (const [key, value] of cors.entries()) {
		headers.set(key, value);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function handlePreflight(request: Request, allowed: string[]): Response {
	const origin = request.headers.get("Origin");
	if (!origin || !isOriginAllowed(origin, allowed)) {
		return new Response(null, { status: 403 });
	}

	return new Response(null, {
		status: 204,
		headers: corsHeaders(origin),
	});
}
