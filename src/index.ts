/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { getAllowedOrigins, handlePreflight, withCors } from "./lib/cors";
import { handleChat } from "./routes/chat";
import { handleNotifyTask } from "./routes/notifyTask";
import { handleTelegram } from "./routes/telegram";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/test" && request.method === "GET") {
			return new Response("тест пройден");
		}

		if (url.pathname === "/api/chat") {
			const allowed = getAllowedOrigins(env);

			if (request.method === "OPTIONS") {
				return handlePreflight(request, allowed);
			}

			if (request.method === "POST") {
				const response = await handleChat(request, env);
				return withCors(response, request, allowed);
			}
		}

		if (url.pathname === "/api/notify-task") {
			const allowed = getAllowedOrigins(env);

			if (request.method === "OPTIONS") {
				return handlePreflight(request, allowed);
			}

			if (request.method === "POST") {
				const response = await handleNotifyTask(request, env);
				return withCors(response, request, allowed);
			}
		}

		if (url.pathname === "/telegram") {
			return handleTelegram(request, env);
		}

		return new Response("Hello World!");
	},
} satisfies ExportedHandler<Env>;
