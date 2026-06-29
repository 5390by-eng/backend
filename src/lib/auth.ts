import { SupabaseError } from "../services/supabase";

export interface AuthenticatedUser {
	id: string;
	email: string | null;
}

function normalizeSupabaseUrl(url: string): string {
	return url.trim().replace(/[\u0000-\u001F\u007F]/g, "").replace(/\/+$/, "");
}

export async function getAuthenticatedUser(
	request: Request,
	env: Env,
): Promise<AuthenticatedUser | null> {
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) {
		return null;
	}

	const token = authorization.slice("Bearer ".length).trim();
	if (!token) {
		return null;
	}

	const baseUrl = normalizeSupabaseUrl(env.SUPABASE_URL);
	const response = await fetch(`${baseUrl}/auth/v1/user`, {
		method: "GET",
		headers: {
			apikey: env.SUPABASE_ANON_KEY,
			Authorization: `Bearer ${token}`,
		},
	});

	if (!response.ok) {
		return null;
	}

	const payload = (await response.json()) as {
		id?: string;
		email?: string | null;
	};

	if (typeof payload.id !== "string") {
		return null;
	}

	return {
		id: payload.id,
		email: typeof payload.email === "string" ? payload.email : null,
	};
}

export async function requireAuthenticatedUser(
	request: Request,
	env: Env,
): Promise<AuthenticatedUser> {
	const user = await getAuthenticatedUser(request, env);
	if (!user) {
		throw new SupabaseError("Unauthorized", 401);
	}

	return user;
}
