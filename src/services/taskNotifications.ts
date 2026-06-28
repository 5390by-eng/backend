import { sendMessage } from "./telegram";
import {
	findTelegramSubscribersByAssigneeNames,
	getUserTelegramLookup,
	type CreatedTask,
	type SupabaseConfig,
	SupabaseError,
} from "./supabase";

function normalizeName(value: string): string {
	return value.trim().toLowerCase();
}

export function formatTaskAssignedNotification(
	boardTitle: string,
	tasks: Array<{ title: string }>,
): string {
	if (tasks.length === 1) {
		return `Вам назначена задача на доске «${boardTitle}»:\n\n• ${tasks[0].title}`;
	}

	const lines = tasks.map((task, index) => `${index + 1}. ${task.title}`);
	return `Вам назначено ${tasks.length} задач на доске «${boardTitle}»:\n\n${lines.join("\n\n")}`;
}

export async function notifyAssigneesAboutNewTasks(
	config: SupabaseConfig,
	botToken: string | undefined,
	boardTitle: string,
	tasks: CreatedTask[],
): Promise<void> {
	if (!botToken || tasks.length === 0) {
		return;
	}

	const assigneeNames = [...new Set(tasks.map((task) => task.assignee.name))];
	const subscribers = await findTelegramSubscribersByAssigneeNames(config, assigneeNames);
	if (subscribers.length === 0) {
		return;
	}

	const tasksByAssignee = new Map<string, CreatedTask[]>();
	for (const task of tasks) {
		const key = normalizeName(task.assignee.name);
		const existing = tasksByAssignee.get(key) ?? [];
		existing.push(task);
		tasksByAssignee.set(key, existing);
	}

	const notifiedChatIds = new Set<number>();

	for (const subscriber of subscribers) {
		if (notifiedChatIds.has(subscriber.chatId)) {
			continue;
		}

		const matchedTasks = tasksByAssignee.get(normalizeName(subscriber.username));
		if (!matchedTasks || matchedTasks.length === 0) {
			continue;
		}

		notifiedChatIds.add(subscriber.chatId);

		try {
			await sendMessage(
				botToken,
				subscriber.chatId,
				formatTaskAssignedNotification(boardTitle, matchedTasks),
			);
		} catch (error) {
			console.error("Failed to send task notification to Telegram chat", subscriber.chatId, error);
		}
	}
}

export interface NotifyUserResult {
	notified: true;
	chatId: number;
	username: string;
}

export async function notifyUserAboutTaskByUserId(
	config: SupabaseConfig,
	botToken: string,
	userId: string,
	boardTitle: string,
	taskTitle: string,
): Promise<NotifyUserResult> {
	const profile = await getUserTelegramLookup(config, userId);
	if (!profile) {
		throw new SupabaseError("User not found", 404);
	}

	const lookupNames = [
		profile.telegramUsername,
		profile.name,
	].filter((value): value is string => typeof value === "string" && value.trim() !== "");

	if (lookupNames.length === 0) {
		throw new SupabaseError("User has no Telegram username or display name", 404);
	}

	const subscribers = await findTelegramSubscribersByAssigneeNames(config, lookupNames);
	const subscriber = subscribers[0];

	if (!subscriber) {
		throw new SupabaseError("User is not subscribed to Telegram notifications", 404);
	}

	await sendMessage(
		botToken,
		subscriber.chatId,
		formatTaskAssignedNotification(boardTitle, [{ title: taskTitle }]),
	);

	return {
		notified: true,
		chatId: subscriber.chatId,
		username: subscriber.username,
	};
}
