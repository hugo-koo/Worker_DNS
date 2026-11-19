import { OverlayToaster } from "@blueprintjs/core";
import React from "react";

export interface FilteringViewProps {
  profileId: string;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export interface ListMetadataStats {
  total_rules: number;
  exact_rules: number;
  subdomain_rules: number;
  wildcard_rules: number;
  regex_rules: number;
  exception_rules: number;
  rewrite_rules: number;
  comment_lines: number;
  unsupported_lines: number;
  total_bytes?: number;
  truncated?: boolean;
}

export interface FilterList {
  id: number;
  url: string;
  last_synced_at?: number;
  last_modified?: number | null;
  etag?: string | null;
  enabled: boolean;
  is_system?: boolean | number;
  scope?: "profile" | "user" | "system";
  scopes?: Array<"profile" | "user" | "system">;
  user_list_id?: number;
  sync_error?: string | null;
  metadata?: ListMetadataStats | null;
}
