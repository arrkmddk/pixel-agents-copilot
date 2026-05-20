import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processCopilotSession, processCopilotTranscriptLine } from './copilotSessionParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS, JSONL_POLL_INTERVAL_MS } from './constants.js';

export function startFileWatching(
	agentId: number,
	filePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	// Primary: fs.watch
	try {
		const watcher = fs.watch(filePath, () => {
			readSessionFile(agentId, agents, waitingTimers, permissionTimers, webview);
		});
		fileWatchers.set(agentId, watcher);
	} catch (e) {
		console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
	}

	// Secondary: stat-based polling (reliable on macOS)
	try {
		fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
			readSessionFile(agentId, agents, waitingTimers, permissionTimers, webview);
		});
	} catch (e) {
		console.log(`[Pixel Agents] fs.watchFile failed for agent ${agentId}: ${e}`);
	}

	// Tertiary: manual poll as last resort
	const interval = setInterval(() => {
		if (!agents.has(agentId)) {
			clearInterval(interval);
			try { fs.unwatchFile(filePath); } catch { /* ignore */ }
			return;
		}
		readSessionFile(agentId, agents, waitingTimers, permissionTimers, webview);
	}, FILE_WATCHER_POLL_INTERVAL_MS);
	pollingTimers.set(agentId, interval);
}

/**
 * Read the Copilot chat session file and process any new content.
 * Supports both the new JSONL transcript format and the legacy JSON format.
 */
export function readSessionFile(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const raw = fs.readFileSync(agent.sessionFile, 'utf-8');
		if (!raw.trim()) return;
		if (agent.sessionFile.endsWith('.jsonl')) {
			// New JSONL transcript format — process only newly appended lines
			const lines = raw.split('\n').filter(l => l.trim());
			const startIdx = agent.lastLineIndex;
			for (let i = startIdx; i < lines.length; i++) {
				processCopilotTranscriptLine(agentId, lines[i], agents, waitingTimers, permissionTimers, webview);
			}
			agent.lastLineIndex = lines.length;
		} else {
			// Legacy JSON format
			processCopilotSession(agentId, raw, agents, waitingTimers, permissionTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
	}
}

export function ensureCopilotSessionScan(
	sessionsDir: string,
	knownSessionFiles: Set<string>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	if (projectScanTimerRef.current) return;

	// Seed old files as known, but passively watch only very recently-active sessions
	const RECENT_SESSION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
	const now = Date.now();
	try {
		const files = fs.readdirSync(sessionsDir)
			.filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
			.map(f => path.join(sessionsDir, f));
		for (const f of files) {
			knownSessionFiles.add(f);
			// Adopt sessions that were active in the last 24h as live agents
			try {
				const mtime = fs.statSync(f).mtimeMs;
				if (now - mtime < RECENT_SESSION_THRESHOLD_MS) {
					adoptSessionFile(
						f, sessionsDir, nextAgentIdRef,
						agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
						webview, persistAgents, true, // passive: skip existing history
					);
				}
			} catch { /* ignore stat errors */ }
		}
	} catch { /* dir may not exist yet */ }

	projectScanTimerRef.current = setInterval(() => {
		scanForNewSessionFiles(
			sessionsDir, knownSessionFiles, nextAgentIdRef,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, persistAgents,
		);
	}, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewSessionFiles(
	sessionsDir: string,
	knownSessionFiles: Set<string>,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	let files: string[];
	try {
		files = fs.readdirSync(sessionsDir)
			.filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
			.map(f => path.join(sessionsDir, f));
	} catch { return; }

	for (const file of files) {
		if (!knownSessionFiles.has(file)) {
			knownSessionFiles.add(file);
			console.log(`[Pixel Agents] New Copilot session detected: ${path.basename(file)}`);
			adoptSessionFile(
				file, sessionsDir, nextAgentIdRef,
				agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
				webview, persistAgents, false, // not passive: new file, read from start
			);
		}
	}
}

function adoptSessionFile(
	sessionFile: string,
	sessionsDir: string,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	passive = false,
): void {
	// For passive (startup) adoption: skip existing history so we only react to NEW events
	let initialLineIndex = 0;
	if (passive) {
		try {
			const raw = fs.readFileSync(sessionFile, 'utf-8');
			initialLineIndex = raw.split('\n').filter(l => l.trim()).length;
		} catch { /* ignore */ }
	}

	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		sessionFile,
		sessionsDir,
		lastRequestCount: 0,
		lastResponseChunkCount: 0,
		lastLineIndex: initialLineIndex,
		announcedToWebview: !passive,
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};

	agents.set(id, agent);
	// Only persist agents that are announced — passive agents must earn their place
	if (!passive) {
		persistAgents();
	}

	console.log(`[Pixel Agents] Agent ${id}: adopted session ${path.basename(sessionFile)} (passive=${passive})`);
	if (!passive) {
		webview?.postMessage({ type: 'agentCreated', id });
	}

	startFileWatching(id, sessionFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	if (!passive) {
		readSessionFile(id, agents, waitingTimers, permissionTimers, webview);
	}
}

export function reassignAgentToFile(
	agentId: number,
	newFilePath: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop old file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.sessionFile); } catch { /* ignore */ }

	// Clear activity
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);
	clearAgentActivity(agent, agentId, permissionTimers, webview);

	// Swap to new file
	agent.sessionFile = newFilePath;
	agent.lastRequestCount = 0;
	agent.lastResponseChunkCount = 0;
	persistAgents();

	// Start watching new file
	startFileWatching(agentId, newFilePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
	readSessionFile(agentId, agents, waitingTimers, permissionTimers, webview);
}
