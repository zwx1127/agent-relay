export function relayInteractionInstructions(): string {
  return [
    "## Agent Relay Interaction Rules",
    "",
    "In Plan Mode, when you need the user to choose a phase, provide missing intent, answer a blocking question, or resolve a skill workflow gate, call the `request_user_input` tool.",
    "Outside Plan Mode, do not call `request_user_input`; ask one concise blocking question in plain text, stop the turn, and wait for the user's next message.",
    "In Plan Mode, do not rely on plain assistant text such as \"reply with brief or game-design\" for required choices.",
    "If the same required choice is still unresolved, keep the turn blocked on the existing user-input request instead of repeatedly starting new work from the thread goal.",
  ].join("\n");
}

export function relayCapabilityInstructions(helperPath: string, capabilityInstructions?: string): string {
  return [
    "## Agent Relay Capabilities",
    "",
    "This Codex session can call local agent-relay capabilities through the helper exposed in `AGENT_RELAY_HELPER`.",
    "",
    capabilityInstructions ?? sendImageCapabilityInstructions(helperPath),
  ].join("\n");
}

export function mentionAgentCapabilityInstructions(helperPath: string, agentName: string | undefined, peerIds: string[]): string {
  return [
    "### mention_agent",
    "",
    "Use this capability when you need to ask another configured agent bot in the same IM group to do related work.",
    agentName ? `Your relay agent name is: ${agentName}.` : undefined,
    peerIds.length > 0 ? `Configured peer agent ids: ${peerIds.join(", ")}.` : "No peer agents are configured.",
    "",
    "Workflow:",
    "1. Write a concise message naming the concrete work you need from the peer.",
    "2. Send it with:",
    "",
    "```bash",
    '\"$AGENT_RELAY_HELPER\" mention-agent <peer-id> \"message\" --cwd \"$PWD\"',
    "```",
    "",
    `If AGENT_RELAY_HELPER is unavailable, the helper path for this relay is: ${helperPath}`,
    "",
    "After mentioning another agent, keep working on your own assigned task unless you are blocked on its answer.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function sendImageCapabilityInstructions(helperPath: string): string {
  return [
    "### send_image",
    "",
    "Use this capability when working on H5/web UI, Playwright browser rendering, visual regressions, layout inspection, or any task where the user needs to see a rendered screen remotely.",
    "",
    "Workflow:",
    "1. Render the target page locally with the appropriate dev server and Playwright/browser tooling.",
    "2. Save the screenshot as a PNG, JPG, WEBP, or GIF file inside the current workspace.",
    "3. Send it to the user with:",
    "",
    "```bash",
    '\"$AGENT_RELAY_HELPER\" send-image <screenshot-path> --cwd \"$PWD\" --caption \"short description\"',
    "```",
    "",
    `If AGENT_RELAY_HELPER is unavailable, the helper path for this relay is: ${helperPath}`,
    "",
    "After sending the image, briefly summarize what the screenshot shows and what you will change or verify next.",
  ].join("\n");
}
