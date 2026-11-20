/**
 * Canonical Access Point device_type identifiers shared across validation,
 * persistence, and Demo Mode seeding.
 */
export const ACCESS_POINT_DEVICE_TYPES = [
  // Browsers
  "chrome",
  "edge",
  "safari",
  "firefox",
  "brave",
  "other_browser",
  // Operating Systems
  "macos",
  "ios",
  "windows",
  "windows_server",
  "linux",
  "android",
  "other_os",
  // Routers
  "openwrt",
  "mikrotik",
  "opnsense",
  "pfsense",
  "ubiquiti",
  "merlin",
  "other_router",
  // Other Devices
  "android_tv",
  "apple_tv",
  "other_tv",
  "nas",
  "other_device",
] as const;

export type AccessPointDeviceType = (typeof ACCESS_POINT_DEVICE_TYPES)[number];

export const DEFAULT_ACCESS_POINT_DEVICE_TYPE: AccessPointDeviceType = "other_device";

const VALID_DEVICE_TYPE_SET = new Set<string>(ACCESS_POINT_DEVICE_TYPES);

/**
 * Checks whether a candidate string is a supported Access Point device_type identifier.
 */
export function isValidAccessPointDeviceType(value: unknown): value is AccessPointDeviceType {
  return typeof value === "string" && VALID_DEVICE_TYPE_SET.has(value.trim());
}

/**
 * Normalizes any stored or user-provided device_type to a canonical key.
 */
export function normalizeAccessPointDeviceType(value: unknown): AccessPointDeviceType {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (VALID_DEVICE_TYPE_SET.has(trimmed)) {
      return trimmed as AccessPointDeviceType;
    }
  }
  return DEFAULT_ACCESS_POINT_DEVICE_TYPE;
}
