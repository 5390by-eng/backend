import { assignRoundRobin } from "./assignment";
import { decomposeTask, OpenRouterError } from "./openrouter";
import {
	boardExists,
	createTasks,
	getBoardMembers,
	type BoardMember,
	type CreatedTask,
	type SupabaseConfig,
	SupabaseError,
} from "./supabase";

export { OpenRouterError, SupabaseError };

export async function createTasksFromMessage(
	config: SupabaseConfig,
	openRouterApiKey: string,
	boardId: string,
	message: string,
): Promise<CreatedTask[]> {
	const exists = await boardExists(config, boardId);
	if (!exists) {
		throw new SupabaseError("Board not found", 404);
	}

	const members = await getBoardMembers(config, boardId);
	if (members.length === 0) {
		throw new SupabaseError("Board has no members", 404);
	}

	const subtasks = await decomposeTask(openRouterApiKey, message.trim());
	const assignments = assignRoundRobin(
		subtasks.map((subtask) => ({ title: subtask.task })),
		members,
	);

	return createTasks(
		config,
		boardId,
		assignments.map((assignment, index) => ({
			title: assignment.item.title,
			assigneeId: assignment.assignee.id,
			position: index,
			assignee: assignment.assignee as BoardMember,
		})),
	);
}
