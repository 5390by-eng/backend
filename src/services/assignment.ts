export interface AssignableMember {
	id: string;
}

export interface Assignment<T extends AssignableMember> {
	item: T;
	assignee: AssignableMember;
}

export function assignRoundRobin<T extends AssignableMember>(
	items: T[],
	members: AssignableMember[],
): Assignment<T>[] {
	if (members.length === 0) {
		throw new Error("Cannot assign tasks: no members available");
	}

	return items.map((item, index) => ({
		item,
		assignee: members[index % members.length],
	}));
}
