import { describe, it, expect } from "vitest";
import { assignRoundRobin } from "../src/services/assignment";

describe("assignRoundRobin", () => {
	it("distributes items across members in order", () => {
		const members = [{ id: "a" }, { id: "b" }];
		const items = [{ title: "t1" }, { title: "t2" }, { title: "t3" }];

		const result = assignRoundRobin(items, members);

		expect(result.map((entry) => entry.assignee.id)).toEqual(["a", "b", "a"]);
	});

	it("throws when members list is empty", () => {
		expect(() => assignRoundRobin([{ title: "t1" }], [])).toThrow(
			"Cannot assign tasks: no members available",
		);
	});
});
