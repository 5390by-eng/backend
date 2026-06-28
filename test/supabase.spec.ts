import { describe, it, expect } from "vitest";
import { SupabaseError, resolveSupabaseApiKey } from "../src/services/supabase";

describe("Supabase config", () => {
	it("rejects corrupted SUPABASE_URL values", async () => {
		const { boardExists } = await import("../src/services/supabase");

		await expect(
			boardExists(
				{
					url: "\u0016",
					apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test",
				},
				"f8ed713c-2730-422f-9841-9f86ba24af44",
			),
		).rejects.toBeInstanceOf(SupabaseError);
	});

	it("prefers service role key when available", () => {
		const key = resolveSupabaseApiKey({
			SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon.anon",
			SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service.service",
		} as Env);

		expect(key).toBe("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service.service");
	});
});
