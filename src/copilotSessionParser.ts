import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
	cancelWaitingTimer,
	startWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
	cancelPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	TEXT_IDLE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['copilot_askQuestion']);

// ── Copilot JSON session format types ────────────────────────

interface CopilotResponseChunk {
	kind?: string;
	value?: string;
	toolId?: string;
	toolCallId?: string;
	toolName?: string;
	invocationMessage?: { value?: string };
	pastTenseMessage?: { value?: string };
	isComplete?: boolean;
	isConfirmed?: boolean;
	// Sub-agent / nested sessions can wrap requests
	requests?: CopilotRequest[];
}

interface CopilotRequest {
	requestId?: string;
	message?: { text?: string };
	response?: CopilotResponseChunk[];
	/** Nested sub-agent session requests */
	subRequests?: CopilotRequest[];
}

interface CopilotSession {
	requests?: CopilotRequest[];
}

// ── Tool name → human-readable status ────────────────────────

export function formatCopilotTool(toolId: string, invocationMsg?: string): string {
	const msg = invocationMsg || '';
	// Extract file paths from the invocation message (e.g. "Reading /path/to/file, lines 1 to 50")
	const fileMatch = msg.match(/\[?\]?\(file:\/\/([^)#\s]+)/);
	const filePart = fileMatch ? path.basename(decodeURIComponent(fileMatch[1])) : '';

	switch (toolId) {
		case 'copilot_readFile':
			return filePart ? `Reading ${filePart}` : 'Reading file';
		case 'copilot_writeFile':
		case 'copilot_createFile':
			return filePart ? `Writing ${filePart}` : 'Writing file';
		case 'copilot_replaceString':
		case 'copilot_editFile':
		case 'copilot_applyEdit':
			return filePart ? `Editing ${filePart}` : 'Editing file';
		case 'copilot_findTextInFiles':
		case 'copilot_searchFiles':
			return 'Searching code';
		case 'copilot_listDirectory':
		case 'copilot_fileTree':
			return 'Listing files';
		case 'copilot_runTests':
			return 'Running tests';
		case 'copilot_runCommand':
		case 'run_in_terminal': {
			// Try to extract command from invocation message
			const cmdMatch = msg.match(/`([^`]+)`/);
			const cmd = cmdMatch?.[1] ?? msg;
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'copilot_getErrors':
			return 'Checking errors';
		case 'copilot_askQuestion':
			return 'Waiting for your answer';
		case 'copilot_insertEdit':
			return filePart ? `Editing ${filePart}` : 'Applying edit';
		default:
			// Strip "copilot_" prefix for display
			return `Using ${toolId.replace(/^copilot_/, '')}`;
	}
}

// ── Main session diff processor ───────────────────────────────

/**
 * Called whenever the session JSON file changes.
 * Diffs against the agent's last known state and emits webview messages.
 */
export function processCopilotSession(
	agentId: number,
	rawJson: string,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	let session: CopilotSession;
	try {
		session = JSON.parse(rawJson) as CopilotSession;
	} catch {
		return; // incomplete JSON write in progress
	}

	const requests = session.requests ?? [];

	// Flat list of all response chunks across all requests (index: [reqIdx, chunkIdx])
	// We process from where we last left off.
	const prevReqCount = agent.lastRequestCount;
	const prevChunkCount = agent.lastResponseChunkCount;

	// Handle new requests (turns)
	if (requests.length > prevReqCount) {
		// A new user turn started
		for (let i = prevReqCount; i < requests.length; i++) {
			const req = requests[i];
			if (i > prevReqCount || (i === prevReqCount && prevChunkCount === 0)) {
				// New turn — clear previous activity
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, webview);
				agent.hadToolsInTurn = false;
				if (agent.permissionSent) {
					agent.permissionSent = false;
					webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
				}
			}
			processRequestChunks(agentId, req, 0, agents, waitingTimers, permissionTimers, webview);
		}
		agent.lastRequestCount = requests.length;
		// Track chunk count for last request
		const lastReq = requests[requests.length - 1];
		agent.lastResponseChunkCount = countAllChunks(lastReq);
	} else if (requests.length === prevReqCount && requests.length > 0) {
		// Same number of requests — check if last request got new chunks
		const lastReq = requests[prevReqCount - 1];
		const currentChunkCount = countAllChunks(lastReq);

		if (currentChunkCount > prevChunkCount) {
			// Cancel timers — new data arriving
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			if (agent.permissionSent) {
				agent.permissionSent = false;
				webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
			}
			processRequestChunks(agentId, lastReq, prevChunkCount, agents, waitingTimers, permissionTimers, webview);
			agent.lastResponseChunkCount = currentChunkCount;
		}
	}
}

/** Count all response chunks including nested sub-agent requests */
function countAllChunks(req: CopilotRequest): number {
	let count = req.response?.length ?? 0;
	for (const sub of req.subRequests ?? []) {
		count += countAllChunks(sub);
	}
	return count;
}

/** Process chunks from startIdx onwards for a given request */
function processRequestChunks(
	agentId: number,
	req: CopilotRequest,
	startIdx: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const chunks = req.response ?? [];
	let hasNonExemptTool = false;

	for (let i = startIdx; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk.kind) continue;

		const agent = agents.get(agentId);
		if (!agent) return;

		if (chunk.kind === 'prepareToolInvocation') {
			// Tool is about to start
			const toolId = chunk.toolName ?? chunk.toolId ?? '';
			if (toolId) {
				const toolCallId = `tool_${agentId}_${i}`;
				const status = formatCopilotTool(toolId);
				agent.activeToolIds.add(toolCallId);
				agent.activeToolStatuses.set(toolCallId, status);
				agent.activeToolNames.set(toolCallId, toolId);
				agent.hadToolsInTurn = true;
				agent.isWaiting = false;
				cancelWaitingTimer(agentId, waitingTimers);
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId: toolCallId, status });
				if (!PERMISSION_EXEMPT_TOOLS.has(toolId)) {
					hasNonExemptTool = true;
				}
			}
		} else if (chunk.kind === 'toolInvocationSerialized') {
			const toolId = chunk.toolId ?? '';
			const toolCallId = chunk.toolCallId ?? `tool_${agentId}_${i}`;
			const invocationMsg = chunk.invocationMessage?.value ?? '';
			const status = formatCopilotTool(toolId, invocationMsg);

			if (!chunk.isComplete) {
				// Tool running
				if (!agent.activeToolIds.has(toolCallId)) {
					agent.activeToolIds.add(toolCallId);
					agent.hadToolsInTurn = true;
					agent.isWaiting = false;
					cancelWaitingTimer(agentId, waitingTimers);
					webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				}
				agent.activeToolStatuses.set(toolCallId, status);
				agent.activeToolNames.set(toolCallId, toolId);
				webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId: toolCallId, status });
				if (!PERMISSION_EXEMPT_TOOLS.has(toolId)) {
					hasNonExemptTool = true;
				}
			} else {
				// Tool completed
				if (agent.activeToolIds.has(toolCallId)) {
					agent.activeToolIds.delete(toolCallId);
					agent.activeToolStatuses.delete(toolCallId);
					agent.activeToolNames.delete(toolCallId);
					const id = toolCallId;
					setTimeout(() => {
						webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId: id });
					}, TOOL_DONE_DELAY_MS);
				}
				// If all tools done — reset hadToolsInTurn to allow text-idle timer
				if (agent.activeToolIds.size === 0) {
					agent.hadToolsInTurn = false;
				}
			}
		} else if (chunk.kind === 'markdownContent' || (chunk.kind === undefined && typeof chunk.value === 'string')) {
			// Text response chunk — if no tools used yet, start idle timer
			const agent2 = agents.get(agentId);
			if (agent2 && typeof chunk.value === 'string' && chunk.value.trim() && !agent2.hadToolsInTurn) {
				startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
			}
		} else if (chunk.kind === 'progressMessage' || chunk.kind === 'agentMessage') {
			// Copilot sub-agent output — treat like text
			const agent2 = agents.get(agentId);
			if (agent2 && !agent2.hadToolsInTurn) {
				startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
			}
		}
	}

	// Also process nested sub-requests (sub-agents)
	for (const subReq of req.subRequests ?? []) {
		processSubagentRequest(agentId, subReq, agents, waitingTimers, permissionTimers, webview);
	}

	if (hasNonExemptTool) {
		startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
	}

	// Check if the last request appears complete (all tools done + text response present)
	const agent = agents.get(agentId);
	if (agent && agent.activeToolIds.size === 0 && !agent.isWaiting) {
		const hasTextChunk = chunks.some(c => typeof c.value === 'string' && c.value.trim());
		if (hasTextChunk && agent.hadToolsInTurn === false) {
			// Response looks complete
			cancelPermissionTimer(agentId, permissionTimers);
			agent.isWaiting = true;
			agent.permissionSent = false;
			webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
		}
	}
}

/** Handle sub-agent request chunks — map to parent agent's sub-agent tracking */
function processSubagentRequest(
	parentAgentId: number,
	subReq: CopilotRequest,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(parentAgentId);
	if (!agent) return;
	const parentToolId = subReq.requestId ?? 'subagent';
	const chunks = subReq.response ?? [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk.kind) continue;

		if (chunk.kind === 'toolInvocationSerialized') {
			const toolId = chunk.toolId ?? '';
			const toolCallId = chunk.toolCallId ?? `subtool_${parentAgentId}_${i}`;
			const invocationMsg = chunk.invocationMessage?.value ?? '';
			const status = formatCopilotTool(toolId, invocationMsg);

			if (!chunk.isComplete) {
				// Track sub-tool start
				let subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (!subTools) { subTools = new Set(); agent.activeSubagentToolIds.set(parentToolId, subTools); }
				subTools.add(toolCallId);

				let subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (!subNames) { subNames = new Map(); agent.activeSubagentToolNames.set(parentToolId, subNames); }
				subNames.set(toolCallId, toolId);

				webview?.postMessage({ type: 'subagentToolStart', id: parentAgentId, parentToolId, toolId: toolCallId, status });

				if (!PERMISSION_EXEMPT_TOOLS.has(toolId)) {
					startPermissionTimer(parentAgentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
				}
			} else {
				// Sub-tool done
				agent.activeSubagentToolIds.get(parentToolId)?.delete(toolCallId);
				agent.activeSubagentToolNames.get(parentToolId)?.delete(toolCallId);
				const id = toolCallId;
				setTimeout(() => {
					webview?.postMessage({ type: 'subagentToolDone', id: parentAgentId, parentToolId, toolId: id });
				}, 300);
			}
		}
	}
}

// ── New Copilot transcript JSONL format (VS Code 1.109+) ──────

const NEW_FORMAT_PERMISSION_EXEMPT = new Set(['vscode_askQuestions']);

/**
 * Format a tool name + arguments from the new transcript JSONL format into a human-readable status.
 */
function formatNewCopilotTool(toolName: string, args: Record<string, unknown>): string {
	const filePath = ((args.filePath ?? args.path ?? args.file_path ?? '') as string);
	const baseName = filePath ? path.basename(filePath) : '';
	switch (toolName) {
		case 'read_file': return baseName ? `Reading ${baseName}` : 'Reading file';
		case 'create_file': return baseName ? `Writing ${baseName}` : 'Writing file';
		case 'replace_string_in_file':
		case 'multi_replace_string_in_file': return baseName ? `Editing ${baseName}` : 'Editing file';
		case 'grep_search':
		case 'semantic_search': return 'Searching code';
		case 'file_search': return 'Searching files';
		case 'list_dir': return 'Listing files';
		case 'run_in_terminal': {
			const cmd = (args.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'get_errors': return 'Checking errors';
		case 'vscode_askQuestions': return 'Waiting for your answer';
		case 'memory': return 'Accessing memory';
		default: return `Using ${toolName}`;
	}
}

/**
 * Process a single line from the new Copilot transcript JSONL format.
 * Events: session.start, assistant.turn_start, tool.execution_start,
 *         tool.execution_complete, assistant.message, assistant.turn_end, user.message
 */
export function processCopilotTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const record = JSON.parse(line) as {
			type: string;
			data?: {
				toolCallId?: string;
				toolName?: string;
				arguments?: Record<string, unknown>;
				success?: boolean;
				turnId?: string;
			};
		};
		const data = record.data ?? {};

		switch (record.type) {
			case 'user.message': {
				// New user prompt — announce agent if first activity, then reset turn state
				if (!agent.announcedToWebview) {
					webview?.postMessage({ type: 'agentCreated', id: agentId });
					agent.announcedToWebview = true;
				}
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, webview);
				agent.hadToolsInTurn = false;
				break;
			}
			case 'assistant.turn_start': {
				// Announce agent if first activity
				if (!agent.announcedToWebview) {
					webview?.postMessage({ type: 'agentCreated', id: agentId });
					agent.announcedToWebview = true;
				}
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				break;
			}
			case 'tool.execution_start': {
				const { toolCallId, toolName = '', arguments: args = {} } = data;
				if (!toolCallId) break;
				// Announce passive agent if a tool fires before we saw user.message
				if (!agent.announcedToWebview) {
					webview?.postMessage({ type: 'agentCreated', id: agentId });
					agent.announcedToWebview = true;
				}
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				const status = formatNewCopilotTool(toolName, args as Record<string, unknown>);
				agent.activeToolIds.add(toolCallId);
				agent.activeToolStatuses.set(toolCallId, status);
				agent.activeToolNames.set(toolCallId, toolName);
				webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId: toolCallId, status });
				if (!NEW_FORMAT_PERMISSION_EXEMPT.has(toolName)) {
					startPermissionTimer(agentId, agents, permissionTimers, NEW_FORMAT_PERMISSION_EXEMPT, webview);
				}
				break;
			}
			case 'tool.execution_complete': {
				const { toolCallId } = data;
				if (!toolCallId) break;
				agent.activeToolIds.delete(toolCallId);
				agent.activeToolStatuses.delete(toolCallId);
				agent.activeToolNames.delete(toolCallId);
				const tid = toolCallId;
				setTimeout(() => {
					webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId: tid });
				}, TOOL_DONE_DELAY_MS);
				if (agent.activeToolIds.size === 0) {
					agent.hadToolsInTurn = false;
				}
				break;
			}
			case 'assistant.turn_end': {
				// Definitive turn end — agent is now waiting for user
				cancelWaitingTimer(agentId, waitingTimers);
				cancelPermissionTimer(agentId, permissionTimers);
				if (agent.activeToolIds.size > 0) {
					agent.activeToolIds.clear();
					agent.activeToolStatuses.clear();
					agent.activeToolNames.clear();
					webview?.postMessage({ type: 'agentToolsClear', id: agentId });
				}
				agent.isWaiting = true;
				agent.permissionSent = false;
				agent.hadToolsInTurn = false;
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
				break;
			}
		}
	} catch {
		// Ignore malformed lines
	}
}
