import type { AppConfig } from "../../runtime/config.ts";
import { CodexDriver } from "./codex/driver.ts";
import { noopLogger, type Logger } from "../../domain/logger.ts";
import type { AgentDriver, AgentExitHandler, AgentOutputHandler } from "../../ports/agent.ts";
import { relayInteractionInstructions } from "../../relay/control/skills.ts";

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
          developerInstructions: composeCodexDeveloperInstructions(config.codexDeveloperInstructions, options.controlInstructions),
          baseInstructions: config.codexBaseInstructions,
          env: options.controlEnv,
        },
        options.onOutput,
        options.onExit,
        logger,
      );
  }
}

export function composeCodexDeveloperInstructions(userInstructions?: string, controlInstructions?: string): string {
  return [userInstructions, relayInteractionInstructions(), controlInstructions].filter(Boolean).join("\n\n");
}
