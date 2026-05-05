export function truncateForTelegramLabel(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return ".".repeat(maxChars);
  const head = Math.ceil((maxChars - 3) / 2);
  const tail = Math.floor((maxChars - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

export function contextUsageBar(percent: number | undefined, width = 5): string {
  const safeWidth = Math.max(1, Math.floor(width));
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "▱".repeat(safeWidth);
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * safeWidth);
  return `${"▰".repeat(filled)}${"▱".repeat(safeWidth - filled)}`;
}
