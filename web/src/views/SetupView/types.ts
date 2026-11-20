import { OverlayToaster } from "@blueprintjs/core";
import type { Profile } from "../../types/auth";

export interface SetupViewProps {
  profiles: Profile[];
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export interface ClientInfo {
  ip: string;
  country: string;
  region?: string;
  city: string;
  timezone?: string;
  asn: number;
  asOrganization: string;
  connectedProfileId?: string;
  substituteDomain?: string;
  dotDomain?: string;
  isServerfull?: boolean;
  mode?: "serverfull" | "cloudflare";
}
