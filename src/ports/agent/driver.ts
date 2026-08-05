import type { ProviderId } from "../../domain/ids.ts";
import type {
  AgentBuiltinCommand,
  AgentBuiltinResult,
  AgentInterruptResult,
  AgentSendOptions,
  AgentSendResult,
} from "./input.ts";
import type { AgentSessionStatus, StartAgentOptions } from "./session.ts";
import type {
  AgentBackgroundTerminalSummary,
  AgentFileSearchOptions,
  AgentFileSearchResult,
  AgentModelSummary,
  AgentSideConversationResult,
  AgentSkillListOptions,
  AgentSkillSummary,
  AgentThreadGoal,
  AgentThreadGoalSetOptions,
  AgentThreadListOptions,
  AgentThreadSummary,
  AgentThreadSwitchResult,
} from "./thread.ts";

export interface AgentDriver {
  readonly providerId?: ProviderId;
  /** Feature flags are advisory; callers still guard each optional method before invoking it. */
  readonly capabilities?: Partial<AgentDriverCapabilities>;
  start(options: StartAgentOptions): Promise<AgentSessionStatus>;
  send(sessionKey: string, text: string, options?: AgentSendOptions): Promise<AgentSendResult>;
  stop(sessionKey: string): Promise<void>;
  /** Release this logical client without interrupting a shared thread. */
  release?(sessionKey: string): Promise<void>;
  getStatus(sessionKey: string): AgentSessionStatus | undefined;
  interrupt?(sessionKey: string): Promise<AgentInterruptResult>;
  respond?(sessionKey: string, requestId: string | number, result: unknown): Promise<void>;
  runBuiltinCommand?(sessionKey: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult>;
  getThreadGoal?(sessionKey: string): Promise<AgentThreadGoal | null>;
  setThreadGoal?(sessionKey: string, goal: AgentThreadGoalSetOptions): Promise<AgentThreadGoal>;
  clearThreadGoal?(sessionKey: string): Promise<boolean>;
  forkThread?(sessionKey: string): Promise<AgentThreadSwitchResult>;
  sideConversation?(sessionKey: string, text: string): Promise<AgentSideConversationResult>;
  renameThread?(sessionKey: string, name: string): Promise<void>;
  archiveThread?(sessionKey: string): Promise<void>;
  deleteThread?(sessionKey: string): Promise<void>;
  cleanBackgroundTerminals?(sessionKey: string): Promise<void>;
  terminateBackgroundTerminal?(sessionKey: string, processId: string): Promise<boolean>;
  listBackgroundTerminals?(sessionKey: string): Promise<AgentBackgroundTerminalSummary[]>;
  listThreads?(options: AgentThreadListOptions): Promise<AgentThreadSummary[]>;
  listModels?(): Promise<AgentModelSummary[]>;
  listSkills?(workspacePath: string, options?: AgentSkillListOptions): Promise<AgentSkillSummary[]>;
  searchFiles?(workspacePath: string, query: string, options?: AgentFileSearchOptions): Promise<AgentFileSearchResult[]>;
}

export interface AgentDriverCapabilities {
  userInputRequests: boolean;
  approvals: boolean;
  builtinCommands: boolean;
  threadFork: boolean;
  sideConversation: boolean;
  threadRename: boolean;
  threadArchive: boolean;
  threadDelete: boolean;
  threadGoals: boolean;
  threadList: boolean;
  modelList: boolean;
  backgroundTerminals: boolean;
  localImages: boolean;
  structuredInputs: boolean;
  localAudio: boolean;
  skillList: boolean;
  fileSearch: boolean;
  imageOutput: boolean;
  interrupt: boolean;
}
