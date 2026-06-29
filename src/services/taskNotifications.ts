import { sendMessage } from "./telegram";
import {
	findTelegramSubscribersByAssigneeNames,
	getUserTelegramLookup,
	type CreatedTask,
	type SupabaseConfig,
	SupabaseError,
} from "./supabase";

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

	const tasksByAssigneeId = new Map<string, CreatedTask[]>();
	for (const task of tasks) {
		const existing = tasksByAssigneeId.get(task.assignee.id) ?? [];
		existing.push(task);
		tasksByAssigneeId.set(task.assignee.id, existing);
	}

	for (const [assigneeId, assigneeTasks] of tasksByAssigneeId) {
		try {
			await notifyUserAboutTasksByUserId(
				config,
				botToken,
				assigneeId,
				boardTitle,
				assigneeTasks,
			);
		} catch (error) {
			if (error instanceof SupabaseError && error.status === 404) {
				continue;
			}

			console.error("Failed to notify assignee about new tasks", assigneeId, error);
		}
	}
}

export interface NotifyUserResult {
	notified: true;
	chatId: number;
	username: string;
}

async function notifyUserAboutTasksByUserId(
	config: SupabaseConfig,
	botToken: string,
	userId: string,
	boardTitle: string,
	tasks: Array<{ title: string }>,
): Promise<NotifyUserResult> {
	const profile = await getUserTelegramLookup(config, userId);
	if (!profile) {
		throw new SupabaseError("User not found", 404);
	}

	const lookupNames = [profile.telegramUsername, profile.name].filter(
		(value): value is string => typeof value === "string" && value.trim() !== "",
	);

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
		formatTaskAssignedNotification(boardTitle, tasks),
	);

	return {
		notified: true,
		chatId: subscriber.chatId,
		username: subscriber.username,
	};
}

export async function notifyUserAboutTaskByUserId(
	config: SupabaseConfig,
	botToken: string,
	userId: string,
	boardTitle: string,
	taskTitle: string,
): Promise<NotifyUserResult> {
	return notifyUserAboutTasksByUserId(config, botToken, userId, boardTitle, [{ title: taskTitle }]);
}
