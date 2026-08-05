import type { LogLevel } from "../domain/logger.ts";

export interface AppConfig {
  imProvider: "telegram" | "lark";
  agentProvider: "codex";
  allowedUserIds: Set<string>;
  allowedConversationIds?: Set<string>;
  mediaMaxBytes: number;
  telegramBotToken?: string;
  telegramBotUsername?: string;
  telegramPollTimeoutSeconds: number;
  telegramRequestRetryMaxAttempts: number;
  telegramRetryInitialDelayMs: number;
  telegramRetryMaxDelayMs: number;
  larkAppId?: string;
  larkAppSecret?: string;
  larkDomain: string;
  larkCardActionDispatchDelayMs: number;
  workspaceRoot: string;
  sqlitePath: string;
  codexBin: string;
  codexSandbox: string;
  codexApproval: string;
  codexDeveloperInstructions?: string;
  codexBaseInstructions?: string;
  relayAgentName?: string;
  relayPeerAgents: RelayPeerAgent[];
  relayControlEnabled: boolean;
  relayControlPort: number;
  /** Opt-in gate for the experimental shared Codex Gateway. */
  experimentalRelayWorkEnabled: boolean;
  experimentalRelayGatewayPort: number;
  experimentalRelayGatewayStatePath: string;
  logLevel: LogLevel;
}

export interface RelayPeerAgent {
  id: string;
  name?: string;
  telegramUsername?: string;
  larkOpenId?: string;
  larkUserId?: string;
}

export type Env = Record<string, string | undefined>;
