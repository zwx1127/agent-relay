import type { AppConfig } from "../app/config.ts";
import { CodexDriver } from "./codex/driver.ts";
import { noopLogger, type Logger } from "../core/logger.ts";
import type { AgentDriver, AgentExitHandler, AgentOutputHandler } from "./types.ts";

export interface AgentFactoryOptions {
  controlEnv?: Record<string, string>;
  controlInstructions?: string;
  onOutput: AgentOutputHandler;
  onExit: AgentExitHandler;
  logger?: Logger;
}

export function createAgentDriver(config: AppConfig, options: AgentFactoryOptions): AgentDriver {
  const logger = options.logger ?? noopLogger;
  switch (config.agentProvider) {
    case "codex":
      return new CodexDriver(
        {
          codexBin: config.codexBin,
          sandbox: config.codexSandbox,
          approval: config.codexApproval,
          developerInstructions: [config.codexDeveloperInstructions, options.controlInstructions].filter(Boolean).join("\n\n") || undefined,
          baseInstructions: config.codexBaseInstructions,
          env: options.controlEnv,
        },
        options.onOutput,
        options.onExit,
        logger,
      );
  }
}
