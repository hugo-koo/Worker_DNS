export type DeviceTypeCategory = "browser" | "os" | "router" | "other";

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

export interface DeviceTypeMeta {
  value: AccessPointDeviceType;
  category: DeviceTypeCategory;
  labelKey: string;
  defaultLabel: string;
}

export const DEVICE_CATEGORY_META: Record<
  DeviceTypeCategory,
  { labelKey: string; defaultLabel: string }
> = {
  browser: { labelKey: "setup.deviceCategoryBrowser", defaultLabel: "Browsers" },
  os: { labelKey: "setup.deviceCategoryOs", defaultLabel: "Operating Systems" },
  router: { labelKey: "setup.deviceCategoryRouter", defaultLabel: "Routers" },
  other: { labelKey: "setup.deviceCategoryOther", defaultLabel: "Other Devices" },
};

export const DEVICE_TYPE_LIST: readonly DeviceTypeMeta[] = [
  // Browsers
  { value: "chrome", category: "browser", labelKey: "setup.deviceTypeChrome", defaultLabel: "Chrome" },
  { value: "edge", category: "browser", labelKey: "setup.deviceTypeEdge", defaultLabel: "Microsoft Edge" },
  { value: "safari", category: "browser", labelKey: "setup.deviceTypeSafari", defaultLabel: "Safari" },
  { value: "firefox", category: "browser", labelKey: "setup.deviceTypeFirefox", defaultLabel: "Firefox" },
  { value: "brave", category: "browser", labelKey: "setup.deviceTypeBrave", defaultLabel: "Brave" },
  { value: "other_browser", category: "browser", labelKey: "setup.deviceTypeOtherBrowser", defaultLabel: "Other Browser" },
  // Operating Systems
  { value: "macos", category: "os", labelKey: "setup.deviceTypeMacos", defaultLabel: "macOS" },
  { value: "ios", category: "os", labelKey: "setup.deviceTypeIos", defaultLabel: "iOS / iPadOS" },
  { value: "windows", category: "os", labelKey: "setup.deviceTypeWindows", defaultLabel: "Windows" },
  { value: "windows_server", category: "os", labelKey: "setup.deviceTypeWindowsServer", defaultLabel: "Windows Server" },
  { value: "linux", category: "os", labelKey: "setup.deviceTypeLinux", defaultLabel: "Linux" },
  { value: "android", category: "os", labelKey: "setup.deviceTypeAndroid", defaultLabel: "Android" },
  { value: "other_os", category: "os", labelKey: "setup.deviceTypeOtherOs", defaultLabel: "Other OS" },
  // Routers
  { value: "openwrt", category: "router", labelKey: "setup.deviceTypeOpenwrt", defaultLabel: "OpenWRT" },
  { value: "mikrotik", category: "router", labelKey: "setup.deviceTypeMikrotik", defaultLabel: "RouterOS" },
  { value: "opnsense", category: "router", labelKey: "setup.deviceTypeOpnsense", defaultLabel: "OPNsense" },
  { value: "pfsense", category: "router", labelKey: "setup.deviceTypePfsense", defaultLabel: "pfSense" },
  { value: "ubiquiti", category: "router", labelKey: "setup.deviceTypeUbiquiti", defaultLabel: "Ubiquiti" },
  { value: "merlin", category: "router", labelKey: "setup.deviceTypeMerlin", defaultLabel: "Merlin" },
  { value: "other_router", category: "router", labelKey: "setup.deviceTypeOtherRouter", defaultLabel: "Other Router" },
  // Other Devices
  { value: "android_tv", category: "other", labelKey: "setup.deviceTypeAndroidTv", defaultLabel: "Android TV" },
  { value: "apple_tv", category: "other", labelKey: "setup.deviceTypeAppleTv", defaultLabel: "Apple TV" },
  { value: "other_tv", category: "other", labelKey: "setup.deviceTypeOtherTv", defaultLabel: "Other TV" },
  { value: "nas", category: "other", labelKey: "setup.deviceTypeNas", defaultLabel: "NAS / Server" },
  { value: "other_device", category: "other", labelKey: "setup.deviceTypeOtherDevice", defaultLabel: "Other Device" },
];

const DEVICE_TYPE_MAP = new Map<string, DeviceTypeMeta>(
  DEVICE_TYPE_LIST.map((item) => [item.value, item])
);

/**
 * Resolves metadata for a stored device_type string, falling back cleanly to `other_device`.
 */
export function getDeviceTypeMeta(deviceType?: string | null): DeviceTypeMeta {
  if (deviceType && DEVICE_TYPE_MAP.has(deviceType)) {
    return DEVICE_TYPE_MAP.get(deviceType)!;
  }
  return DEVICE_TYPE_MAP.get(DEFAULT_ACCESS_POINT_DEVICE_TYPE)!;
}

export type SetupTabId = "browsers" | "apple" | "windows" | "linux" | "routeros" | "android";

const DEVICE_TYPE_TO_SETUP_TAB: Partial<Record<AccessPointDeviceType, SetupTabId>> = {
  // Browsers
  chrome: "browsers",
  edge: "browsers",
  safari: "browsers",
  firefox: "browsers",
  brave: "browsers",
  other_browser: "browsers",
  // Apple ecosystem
  macos: "apple",
  ios: "apple",
  apple_tv: "apple",
  // Windows
  windows: "windows",
  windows_server: "windows",
  // Linux
  linux: "linux",
  // RouterOS
  mikrotik: "routeros",
  // Android
  android: "android",
};

/**
 * Maps an Access Point device_type to the matching Setup guide tab,
 * returning null for device types without a dedicated guide tab so the current tab remains unchanged.
 */
export function resolveSetupTabForDeviceType(deviceType?: string | null): SetupTabId | null {
  const resolved = getDeviceTypeMeta(deviceType).value;
  return DEVICE_TYPE_TO_SETUP_TAB[resolved] ?? null;
}
