import { D1Database, ExecutionContext as CFExecutionContext } from "@cloudflare/workers-types";
import type { AccessKeyDoNamespace } from "./lib/accessKeyRegistry";

export interface DatabaseStorageStats {
  dbPath: string;
  snapshotDir: string;
  sameFilesystem: boolean;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsedBytes: number;
  dbMainBytes: number;
  dbWalBytes: number;
  dbShmBytes: number;
  dbTotalBytes: number;
  snapshotsTotalBytes: number;
  snapshotDiskTotalBytes?: number;
  snapshotDiskFreeBytes?: number;
}

export interface DatabaseSnapshotItem {
  filename: string;
  sizeBytes: number;
  /** Creation Unix timestamp in seconds. */
  createdAt: number;
  /** Expiration Unix timestamp in seconds (0 = never expires). */
  expiresAt: number;
}

export interface ActiveSnapshotCapture {
  id: string;
  /** Capture start Unix timestamp in seconds. */
  startedAt: number;
  stage: 'vacuumming' | 'compressing' | 'cancelling';
  /** Overall capture completion percentage (0-100). */
  progress: number;
}

export interface DatabaseSnapshotOverview {
  supported: boolean;
  storage: DatabaseStorageStats | null;
  snapshots: DatabaseSnapshotItem[];
  activeCapture: ActiveSnapshotCapture | null;
  config: {
    retentionDays: number;
    maxCount: number;
    snapshotDir: string;
  };
}

export interface ServerfullSnapshotBridge {
  getOverview(): Promise<DatabaseSnapshotOverview>;
  startCapture(): Promise<ActiveSnapshotCapture>;
  abortCapture(): Promise<{ aborted: boolean }>;
  deleteSnapshots(filenames: string[]): Promise<{ deletedCount: number }>;
  openSnapshotDownload(filename: string, rangeHeader?: string | null): Promise<{
    stream: ReadableStream<Uint8Array> | null;
    status: 200 | 206 | 416;
    sizeBytes: number;
    contentLength: number;
    contentRange?: string;
    etag: string;
    filename: string;
  } | null>;
}

export type ReleaseChannel = 'latest' | 'alpha' | 'canary';

export type ServerfullInstallMethod = 'npm-global' | 'docker' | 'source' | 'npx' | 'unknown';

export type ServerfullServiceManager = 'systemd' | 'docker' | 'schtasks' | 'none';

export interface ReleaseChannelInfo {
  channel: ReleaseChannel;
  version: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

export interface ServerfullRuntimeStatus {
  supported: boolean;
  currentVersion: string;
  currentChannel: ReleaseChannel;
  /** Process startup Unix timestamp in seconds. */
  startedAt: number;
  runtime: string;
  platform: string;
  installMethod: ServerfullInstallMethod;
  serviceManager: ServerfullServiceManager;
  workersCount: number;
  canRestart: boolean;
  restartReason: string | null;
  /** Last npm registry check Unix timestamp in seconds. */
  checkedAt: number | null;
  checkError: string | null;
  channels: Record<ReleaseChannel, ReleaseChannelInfo>;
}

export interface ServerfullRestartResult {
  accepted: boolean;
  /** Current process startup Unix timestamp in seconds prior to restart. */
  startedAt: number;
  estimatedDowntimeSec: number;
  message: string;
}

export interface ServerfullLifecycleBridge {
  getStatus(options?: { forceRefresh?: boolean }): Promise<ServerfullRuntimeStatus>;
  requestRestart(): Promise<ServerfullRestartResult>;
}

export interface Env {
  DB: D1Database;
  ACCESS_KEY_DO?: AccessKeyDoNamespace;
  ASSETS: any;
  SERVERFULL_SNAPSHOT_BRIDGE?: ServerfullSnapshotBridge;
  SERVERFULL_LIFECYCLE_BRIDGE?: ServerfullLifecycleBridge;
  JWT_SECRET?: string;
  MAX_ACCESS_POINTS_PER_PROFILE?: string | number;
  MAX_PROFILES_PER_USER?: string | number;
  MAX_USERS?: string | number;
  DEFAULT_SESSION_EXPIRATION_MINUTES?: string | number;
  OPTIONAL_SESSION_EXPIRATION_DAYS?: string | number;
  SESSION_ABSOLUTE_MAX_MINUTES?: string | number;
  OPTIONAL_SESSION_ABSOLUTE_MAX_DAYS?: string | number;
  ACCESS_TOKEN_EXPIRATION_MINUTES?: string | number;
  SESSION_GEO_DISTANCE_KM?: string | number;
  PREAUTH_TTL_SECONDS?: string | number;
  BLOOM_MEM_TTL?: string | number;
  CONFIG_MEM_TTL?: string | number;
  SYNC_TIMEOUT_MS?: string | number;
  INACTIVITY_THRESHOLD_DAYS?: string | number;
  INACTIVE_LOG_PURGE_DAYS?: string | number;
  INACTIVE_LOG_CLEANUP_DAYS?: string | number;
  DNS_CACHE_SIZE?: string | number;
  PRESET_UPSTREAMS?: string;
  PRESET_EXTERNAL_FILTERS?: string;
  PRESET_ECH_FRONTING_DOMAINS?: string;
  BLOOM_FALSE_POSITIVE_RATE?: string | number;
  THROTTLE_ACTIVE_SEC?: string | number;
  SYNC_PROFILE_INTERVAL_SEC?: string | number;
  TURNSTILE_SECRET_KEY?: string;
  MAX_SYNC_DOMAINS?: string | number;
  MAX_LIST_DOMAINS?: string | number;
  MAX_LIST_BYTES?: string | number;
  MAX_LOG_RETENTION_DAYS?: string | number;
  DEFAULT_LOG_RETENTION_DAYS?: string | number;
  ADMIN_USER_MAX_LOG_RETENTION_DAYS?: string | number;
  MAX_LOGS_PER_PROFILE?: string | number;
  NORMAL_USER_MAX_LOG_RETENTION_DAYS?: string | number;
  NORMAL_USER_DEFAULT_LOG_RETENTION_DAYS?: string | number;
  FAIL_OPEN_UPSTREAM?: string;
  CF_ZONE_ID?: string;
  CF_PURGE_TOKEN?: string;
  SESSION_LAST_ACTIVE_UPDATE_INTERVAL?: string | number;
  AUTH_CACHE_TTL_SEC?: string | number;
  LOG_CLEANUP_BATCH_LIMIT?: string | number;
  LOG_CLEANUP_DAILY_BUDGET?: string | number;
  DOMAIN_ROLLUP_MIN_COUNT?: string | number;
  SERVERFULL_DOT_DOMAIN?: string;
  SERVERFULL_DB_PATH?: string;
  SERVERFULL_SNAPSHOT_DIR?: string;
  SERVERFULL_SNAPSHOT_RETENTION_DAYS?: string | number;
  SERVERFULL_SNAPSHOT_MAX_COUNT?: string | number;
  DOT_DOMAIN?: string;
  SERVERFULL_ECH_ENABLED?: string | boolean;
  SERVERFULL_ECH_CONFIG?: string;
  SERVERFULL_ECH_FRONTING_DOMAIN?: string;
  SERVERFULL_HTTPS_PORT?: string | number;
  SERVERFULL_DOT_PORT?: string | number;
  TRUSTED_PROXIES?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  DATABASE_SERVICE?: 'D1' | 'Turso' | 'File' | string;
  DEMO_MODE?: string | boolean;
  DEMO_DOMAIN?: string;
  [key: string]: any;
}

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
  hashed_password?: string;
  totp_enabled?: number;       // 0 | 1
  totp_skip_password?: number; // 0 | 1 — when 1, login skips password check
  passkeys_count?: number;
  created_at?: number;
  last_resolve_at?: number;
  timezone?: string | null;
  locale?: string | null;
  invite_code?: string | null;
  has_password?: number | boolean;
  password_version?: number;
  pin_hash?: string | null;
  isPaused?: boolean;
  sessionId?: string;
  session_lock_timeout?: number;
}

export interface UserActivityLog {
  id: number;
  user_id: string;
  action: string;
  ip_address: string | null;
  user_agent: string | null;
  timestamp: number;
  extra: string | null;
}

export interface TtlOverrideRule {
  enabled: boolean;
  ttl: number;
}

export interface TtlOverrideSettings {
  pass?: TtlOverrideRule;
  redirect?: TtlOverrideRule;
  block?: TtlOverrideRule;
}

export interface PauseFilteringSettings {
  enabled: boolean;
  /** Duration in seconds configured for the pause timer (0 = indefinite until manually re-enabled). */
  duration_seconds: number;
  /** Unix timestamp in seconds when the pause expires (0 = no automatic expiry). */
  expires_at: number;
}

export interface ProfileSettings {
  upstream: string[];
  ecs: {
    enabled: boolean;
    use_client_ip: boolean;
    ipv4_cidr?: string;
    ipv6_cidr?: string;
  };
  log_retention_days: number;
  skip_log_on_pass?: boolean;
  default_policy: 'ALLOW' | 'BLOCK';
  block_mode?: 'NULL_IP' | 'NXDOMAIN' | 'NODATA' | 'CUSTOM_IP';
  custom_block_ipv4?: string;
  custom_block_ipv6?: string;
  best_effort_ech?: {
    enabled: boolean;
    fronting_domain?: string;
  };
  ttl_override?: TtlOverrideSettings;
  pause_filtering?: PauseFilteringSettings;
}

export interface Profile {
  id: string;
  profile_key?: string;
  owner_id: string;
  name: string;
  settings: string;
  created_at: number;
  updated_at: number;
  list_bloom?: string;
  list_updated_at?: number;
  /** True when synthesized by fail-open recovery after a DB lookup failure. */
  isEmergencyFallback?: boolean;
}

export interface Rule {
  id: number;
  profile_id: string;
  type: 'ALLOW' | 'BLOCK' | 'REDIRECT';
  pattern: string;
  v_a?: string;
  v_aaaa?: string;
  v_txt?: string;
  v_cname?: string;
  created_at?: number;
  include_subdomains?: boolean | number;
  /** Whether the rule is active in DNS filtering (1/true = active, 0/false = disabled). */
  enabled?: boolean | number;
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

export interface List {
  id: number;
  profile_id: string;
  url: string;
  enabled: boolean;
  is_system?: boolean | number;
  scope?: 'profile' | 'user' | 'system';
  user_list_id?: number;
  last_synced_at?: number;
  sync_error?: string | null;
  etag?: string | null;
  last_modified?: number | null;
  metadata?: ListMetadataStats | null;
}

export interface UserList {
  id: number;
  user_id: string;
  url: string;
  is_system: number; // 0 = user-created, 1 = system-distributed
  enabled: boolean;
  created_at: number;
  last_synced_at?: number | null;
  sync_error?: string | null;
  etag?: string | null;
  last_modified?: number | null;
}

export interface DNSQuery {
  name: string;
  type: string;
  raw: Uint8Array;
}

export interface ResolutionResult {
  answer: Uint8Array;
  ttl: number;
  action: 'PASS' | 'BLOCK' | 'REDIRECT' | 'FAIL';
  reason?: string;
  latency?: number;
  timings?: Record<string, number>;
  diagnostics?: {
    upstream_url: string;
    method: string;
    status: number;
    status_text?: string;
    error_detail?: string;
    response_body?: string;
    cf_ray?: string;
  };
}

export interface ResolutionLog {
  id?: number;
  profile_id: string;
  access_point_id?: string;
  timestamp: number;
  client_ip: string;
  geo_country: string;
  domain: string;
  record_type: string;
  action: string;
  reason?: string;
  answer?: string;
  dest_geoip?: string;
  dest_country_code?: string | null;
  dest_country?: string | null;
  dest_isp?: string | null;
  latency?: number;
  ecs?: string;
  upstream?: string;
  encrypt_version?: number; // 0: unencrypted, 1: pure P-256 legacy, 2: P256-MLKEM768 hourly KEM
  kem_key_id?: string | null;
  kem_ct?: string | null;
  encrypted_payload?: string | null;
}

export interface KemKeyRecord {
  id: string;
  profile_id: string;
  kem_ct: string;
  created_at: number;
  expires_at: number;
}

export interface HourlyRollup {
  profile_id: string;
  metric_type: 'action' | 'domain' | 'client' | 'dest' | string;
  hour_timestamp: number;
  key: string;
  sub_key?: string;
  access_point_id?: string;
  count: number;
}

export interface LogHourlyRollup {
  profile_id: string;
  hour_timestamp: number;
  action: 'PASS' | 'BLOCK' | 'REDIRECT' | 'FAIL' | string;
  count: number;
}

export interface ExecutionContext extends CFExecutionContext {}

export interface Context {
  profileId: string;
  accessPointId?: string;
  accessPointName?: string;
  startTime: number;
  env: Env;
  ctx: ExecutionContext;
  /** True when profile lookup fell back to emergency fail-open mode due to DB unavailability. */
  isEmergencyFallback?: boolean;
}

export interface AccessPoint {
  id: string;
  owner_id?: string;
  profile_id: string | null;
  name: string;
  token: string;
  device_type?: string;
  created_at: number;
  updated_at: number;
}

export interface Passkey {
  id: string;
  user_id: string;
  name: string;
  credential_id: string;
  public_key: string;
  algorithm: number;
  sign_count: number;
  transports?: string | null;
  aaguid?: string | null;
  created_at: number;
  last_used_at?: number | null;
}
