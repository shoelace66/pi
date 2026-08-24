export type BackgroundTaskStatus = "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

export type BackgroundTask = {
	id: string;
	sessionId: string;
	command: string;
	cwd: string;
	pid: number;
	status: BackgroundTaskStatus;
	logPath: string;
	createdAt: string;
	updatedAt: string;
	endedAt?: string;
	exitCode?: number;
	error?: string;
};

export type BackgroundTaskEvent = { type: "changed"; task: BackgroundTask };
export type BackgroundTaskListener = (event: BackgroundTaskEvent) => void;

export type StartBackgroundTaskInput = {
	sessionId: string;
	command: string;
	cwd: string;
};
