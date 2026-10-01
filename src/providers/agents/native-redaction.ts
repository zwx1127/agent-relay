/** Redact credential-bearing native diagnostics before they enter logs or IM. */
export function redactNativeDiagnostic(value: unknown, fallback = "The native agent request failed."): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  return message
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL redacted]")
    // Full header lines can contain multiple cookie pairs or auth parameters.
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n{}]+/gi, "[credential redacted]")
    // Accept JSON labels, shell/environment assignments and native error labels.
    // Consume a Bearer prefix together with its value, never just the prefix.
    .replace(/["']?\b[\w.-]*(?:api[_-]?key|token|secret|password|authorization|cookie)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+[^\s,;<>"']+|[^\s,;<>"'}\]]+)/gi, "[credential redacted]")
    .replace(/\bBearer\s+[^\s,;<>"']+/gi, "[credential redacted]")
    .replace(/\bsk-[\w-]+/gi, "[credential redacted]");
}
