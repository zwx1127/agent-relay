import type { AppConfig } from "../../runtime/config.ts";
import { CodexDriver } from "./codex/driver.ts";
import { ClaudeDriver } from "./claude/driver.ts";
import { DshDriver } from "./dsh/driver.ts";
import { noopLogger, type Logger } from "../../domain/logger.ts";
import type { AgentDriver, AgentExitHandler, AgentOutputHandler } from "../../ports/agent.ts";
import { relayInteractionInstructions } from "../../relay/control/skills.ts";

export interface AgentFactoryOptions {
  controlEnv?: Record<string, string>;
  controlInstructions?: string;
  onOutput: AgentOutputHandler;
  onExit: AgentExitHandler;
  logger?: Logger;
  gatewayUrl?: string;
  gatewayUrlProvider?: () => string;
}

export function createAgentDriver(config: AppConfig, options: AgentFactoryOptions): AgentDriver {
  const logger = options.logger ?? noopLogger;
  if (config.agentProvider === "dsh" && (config.relayControlEnabled || options.controlInstructions)) {
    throw new Error("DSH Web does not expose a native relay-helper instruction channel. Set RELAY_CONTROL_ENABLED=false.");
  }
  if (config.agentProvider !== "codex" && (options.gatewayUrl || options.gatewayUrlProvider || config.experimentalRelayWorkEnabled)) {
    throw new Error("The experimental shared Gateway supports only the Codex backend.");
  }
  switch (config.agentProvider) {
    case "claude":
      return new ClaudeDriver({
        claudeBin: config.claudeBin ?? "claude",
        env: options.controlEnv,
        ...(options.controlInstructions ? { appendSystemPrompt: options.controlInstructions } : {}),
      }, options.onOutput, options.onExit, logger);
    case "dsh":
      return new DshDriver({ dshBin: config.dshBin ?? "dsh", env: options.controlEnv }, options.onOutput, options.onExit, logger);
    case "codex":
      return new CodexDriver(
        {
          codexBin: config.codexBin,
          ...(options.gatewayUrl ? { gatewayUrl: options.gatewayUrl } : {}),
          ...(options.gatewayUrlProvider ? { gatewayUrlProvider: options.gatewayUrlProvider } : {}),
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
