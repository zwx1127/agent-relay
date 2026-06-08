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

export function relayCapabilityInstructions(helperPath: string, capabilityInstructions?: string, platform = process.platform): string {
  return [
    "## Agent Relay Capabilities",
    "",
    "This Codex session can call local agent-relay capabilities through the helper exposed in `AGENT_RELAY_HELPER`.",
    "",
    capabilityInstructions ?? [sendImageCapabilityInstructions(helperPath, platform), sendFileCapabilityInstructions(helperPath, platform)].join("\n\n"),
  ].join("\n");
}

export function mentionAgentCapabilityInstructions(helperPath: string, agentName: string | undefined, peerIds: string[], platform = process.platform): string {
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
    helperCommandExample("mention-agent <peer-id> \"message\" --cwd \"$PWD\"", platform),
    "",
    `If AGENT_RELAY_HELPER is unavailable, the helper path for this relay is: ${helperPath}`,
    "",
    "After mentioning another agent, keep working on your own assigned task unless you are blocked on its answer.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function sendImageCapabilityInstructions(helperPath: string, platform = process.platform): string {
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
    helperCommandExample("send-image <screenshot-path> --cwd \"$PWD\" --caption \"short description\"", platform),
    "",
    `If AGENT_RELAY_HELPER is unavailable, the helper path for this relay is: ${helperPath}`,
    "",
    "After sending the image, briefly summarize what the screenshot shows and what you will change or verify next.",
  ].join("\n");
}

export function sendFileCapabilityInstructions(helperPath: string, platform = process.platform): string {
  return [
    "### send_file",
    "",
    "Use this capability when the user needs a generated or existing workspace file sent back to chat, such as a report, log, archive, spreadsheet, document, or other non-image artifact.",
    "",
    "Workflow:",
    "1. Create or locate the file inside the current workspace.",
    "2. Send it to the user with:",
    "",
    helperCommandExample("send-file <file-path> --cwd \"$PWD\" --caption \"short description\"", platform),
    "",
    `If AGENT_RELAY_HELPER is unavailable, the helper path for this relay is: ${helperPath}`,
    "",
    "After sending the file, briefly summarize what the file contains.",
  ].join("\n");
}

function helperCommandExample(args: string, platform: string): string {
  if (platform === "win32") {
    return [
      "```powershell",
      `& "$env:AGENT_RELAY_HELPER" ${args}`,
      "```",
    ].join("\n");
  }
  return [
    "```bash",
    `"$AGENT_RELAY_HELPER" ${args}`,
    "```",
  ].join("\n");
}
