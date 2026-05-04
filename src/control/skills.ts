export function relayCapabilityInstructions(helperPath: string): string {
  return [
    "## Agent Relay Capabilities",
    "",
    "This Codex session can call local agent-relay capabilities through the helper exposed in `AGENT_RELAY_HELPER`.",
    "",
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
