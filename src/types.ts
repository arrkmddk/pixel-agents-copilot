import type * as vscode from 'vscode';

export interface AgentState {
	id: number;
	/** The Copilot chat session JSON file being watched */
	sessionFile: string;
	/** Dir containing the chatSessions folder */
	sessionsDir: string;
	/** Last read state for diffing the JSON file */
	lastRequestCount: number;
	lastResponseChunkCount: number;
	/** Last processed line index for JSONL files */
	lastLineIndex: number;
	/** Whether agentCreated has been sent to the webview */
	announcedToWebview: boolean;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}

export interface PersistedAgent {
	id: number;
	sessionFile: string;
	sessionsDir: string;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}

/** A synthetic "terminal ref" for copilot sessions — just opens the chat panel */
export interface CopilotSessionRef {
	readonly name: string;
	show(): void;
	dispose(): void;
}
