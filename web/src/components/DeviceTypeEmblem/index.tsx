import React from "react";
import { clsx } from "clsx";
import {
  Globe,
  Compass,
  Flame,
  Shield,
  Laptop,
  Smartphone,
  Server,
  Terminal,
  Cpu,
  Router,
  Wifi,
  Tv,
  HardDrive,
  MonitorSmartphone,
} from "lucide-react";
import { getDeviceTypeMeta, type AccessPointDeviceType } from "../../constants/deviceTypes";

export interface DeviceTypeEmblemProps {
  deviceType?: string | null;
  size?: number;
  className?: string;
}

/**
 * Renders crisp monochrome brand or hardware vector emblems for each Access Point device_type.
 */
export const DeviceTypeEmblem: React.FC<DeviceTypeEmblemProps> = ({
  deviceType,
  size = 16,
  className,
}) => {
  const resolved: AccessPointDeviceType = getDeviceTypeMeta(deviceType).value;
  const svgClass = clsx("shrink-0", className);

  switch (resolved) {
    case "chrome":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={svgClass} aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" />
          <circle cx="12" cy="12" r="3.6" />
          <line x1="12" y1="8.4" x2="20.4" y2="8.4" />
          <line x1="8.9" y1="13.8" x2="4.7" y2="6.6" />
          <line x1="15.1" y1="13.8" x2="10.9" y2="21.1" />
        </svg>
      );
    case "edge":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={svgClass} aria-hidden="true">
          <path d="M20.5 13.5a8.5 8.5 0 1 0-7.7 7.9c3.7.3 6.9-1.7 7.9-4.5H13.5a3.8 3.8 0 0 1-3.4-5.4c.8-1.5 2.5-2.3 4.3-2.1 2.2.2 3.9 2.1 3.8 4.1z" />
        </svg>
      );
    case "safari":
      return <Compass size={size} className={svgClass} />;
    case "firefox":
      return <Flame size={size} className={svgClass} />;
    case "brave":
      return <Shield size={size} className={svgClass} />;
    case "other_browser":
      return <Globe size={size} className={svgClass} />;

    case "macos":
      return <Laptop size={size} className={svgClass} />;
    case "ios":
      return <Smartphone size={size} className={svgClass} />;
    case "windows":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={svgClass} aria-hidden="true">
          <rect x="3" y="3" width="8.25" height="8.25" />
          <rect x="12.75" y="3" width="8.25" height="8.25" />
          <rect x="3" y="12.75" width="8.25" height="8.25" />
          <rect x="12.75" y="12.75" width="8.25" height="8.25" />
        </svg>
      );
    case "windows_server":
      return <Server size={size} className={svgClass} />;
    case "linux":
      return <Terminal size={size} className={svgClass} />;
    case "android":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={svgClass} aria-hidden="true">
          <line x1="7.5" y1="5" x2="9.3" y2="8" />
          <line x1="16.5" y1="5" x2="14.7" y2="8" />
          <path d="M5 16.5V12a7 7 0 0 1 14 0v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 16.5Z" />
          <circle cx="9.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case "other_os":
      return <Cpu size={size} className={svgClass} />;

    case "openwrt":
    case "merlin":
    case "other_router":
      return <Router size={size} className={svgClass} />;
    case "mikrotik":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={svgClass} aria-hidden="true">
          <polygon points="12 2.5 20.5 7.3 20.5 16.7 12 21.5 3.5 16.7 3.5 7.3" />
          <polyline points="7.5 15 7.5 9 12 13 16.5 9 16.5 15" />
        </svg>
      );
    case "opnsense":
    case "pfsense":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={svgClass} aria-hidden="true">
          <path d="M12 2.5 20 6v5.8c0 4.8-3.4 9.1-8 10.2-4.6-1.1-8-5.4-8-10.2V6l8-3.5Z" />
          <path d="M9 11h6M9 14.5h4" />
        </svg>
      );
    case "ubiquiti":
      return <Wifi size={size} className={svgClass} />;

    case "android_tv":
    case "apple_tv":
    case "other_tv":
      return <Tv size={size} className={svgClass} />;
    case "nas":
      return <HardDrive size={size} className={svgClass} />;
    case "other_device":
    default:
      return <MonitorSmartphone size={size} className={svgClass} />;
  }
};
