/**
 * Formats a byte count into a human-readable unit string (B, KB, MB, GB, TB).
 *
 * @param bytes - Non-negative byte count
 * @returns Formatted file size string
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  const decimals = idx === 0 ? 0 : value >= 100 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[idx]}`;
}
