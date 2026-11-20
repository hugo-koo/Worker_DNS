import React from "react";
import { clsx } from "clsx";
import { DeviceTypeEmblem } from "../DeviceTypeEmblem";

export interface DeviceTypeStampProps {
  deviceType?: string | null;
  className?: string;
  size?: number;
}

/**
 * Circular stamp watermark placed in the upper-right corner of Access Point cards,
 * mirroring the Swiss-style StepStampWatermark aesthetic and hover blur reveal.
 */
export const DeviceTypeStamp: React.FC<DeviceTypeStampProps> = ({
  deviceType,
  className,
  size = 136,
}) => {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        "absolute -top-7 -right-7 pointer-events-none select-none z-0",
        "text-blue-600/[0.08] dark:text-blue-400/[0.12]",
        "transition-all duration-500 ease-out",
        "blur-none group-hover:blur-md group-hover:opacity-0",
        className
      )}
      style={{ width: size, height: size }}
    >
      <div className="relative w-full h-full flex items-center justify-center">
        <svg
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="w-full h-full"
        >
          <circle
            cx="50"
            cy="50"
            r="46"
            stroke="currentColor"
            strokeWidth="4"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <DeviceTypeEmblem deviceType={deviceType} size={Math.round(size * 0.42)} />
        </div>
      </div>
    </div>
  );
};
