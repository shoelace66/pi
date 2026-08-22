import type { DesktopActivity } from "./view-models.ts";

export const DESKTOP_ACTIVITY_PAGE_SIZE = 50;
export type DesktopActivityFilter = "all" | "messages" | "tools" | "errors";

/**
 * Keep exactly one live run status at the end of the visible conversation.
 * Old builds persisted each phase as another run_started row, so selecting the
 * newest row also repairs those histories at display time.
 */
export function desktopTimelineActivities(
	activities: readonly DesktopActivity[],
	isRunning: boolean,
): readonly DesktopActivity[] {
	const settled = activities.filter((activity) => activity.kind !== "status" || activity.status !== "run_started");
	if (!isRunning) return settled;
	let current: Extract<DesktopActivity, { kind: "status" }> | undefined;
	for (let index = activities.length - 1; index >= 0; index--) {
		const activity = activities[index];
		if (activity?.kind === "status" && activity.status === "run_started") {
			current = activity;
			break;
		}
	}
	return current ? [...settled, current] : settled;
}

export function filterDesktopActivities(
	activities: readonly DesktopActivity[],
	filter: DesktopActivityFilter,
): readonly DesktopActivity[] {
	if (filter === "all") return activities;
	if (filter === "messages") return activities.filter((activity) => activity.kind === "message");
	if (filter === "tools") return activities.filter((activity) => activity.kind === "tool");
	return activities.filter(
		(activity) =>
			(activity.kind === "tool" && activity.tool.status === "error") ||
			(activity.kind === "status" && activity.status === "run_error"),
	);
}

export function desktopActivityWindow(
	activities: readonly DesktopActivity[],
	visibleCount: number,
): { activities: readonly DesktopActivity[]; hiddenCount: number } {
	const count = Math.max(DESKTOP_ACTIVITY_PAGE_SIZE, Math.floor(visibleCount));
	const hiddenCount = Math.max(0, activities.length - count);
	return { activities: activities.slice(hiddenCount), hiddenCount };
}

export function sortDesktopActivities(activities: readonly DesktopActivity[]): DesktopActivity[] {
	return [...activities].sort((left, right) => {
		const time = left.occurredAt.localeCompare(right.occurredAt);
		return time || left.id.localeCompare(right.id);
	});
}

export function upsertDesktopActivity(
	activities: readonly DesktopActivity[],
	activity: DesktopActivity,
): DesktopActivity[] {
	const existingIndex = activities.findIndex((item) => item.kind === activity.kind && item.id === activity.id);
	if (existingIndex >= 0) {
		const next = [...activities];
		next[existingIndex] = activity;
		return activities[existingIndex]?.occurredAt === activity.occurredAt ? next : sortDesktopActivities(next);
	}
	const last = activities[activities.length - 1];
	const inOrder =
		!last ||
		last.occurredAt < activity.occurredAt ||
		(last.occurredAt === activity.occurredAt && last.id <= activity.id);
	if (inOrder) return [...activities, activity];
	return sortDesktopActivities([...activities, activity]);
}
