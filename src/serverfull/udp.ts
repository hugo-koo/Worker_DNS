/**
 * @file udp.ts
 * @description Classic UDP DNS server (RFC 1035 / RFC 6891) for Serverfull mode.
 */

import dgram from 'node:dgram';
import { Buffer } from 'node:buffer';
import { Env, Context, ExecutionContext } from '../types';
import { parseDNSQueryFromRaw } from '../utils/dns';
import { pipeline } from '../pipeline';
import { resolveDefaultProfile, resolveProfileByKey } from '../api/doh';
import { hasAlreadyTriedFailOpen, resolveFailOpenFallback } from '../pipeline/resolver/transport';
import { recordActiveDnsConnection } from '../lib/activeDns';
import { formatPortError } from './format';

export interface UdpServerOptions {
  port: number;
  host: string;
  defaultProfileKey?: string;
  env: Env;
}

export class UdpDnsServer {
  private socket: dgram.Socket | null = null;
  private isRunning: boolean = false;
  private rateBuckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(private options: UdpServerOptions) {}

  private allowUdpPacket(remoteIp: string): boolean {
    const now = Date.now();
    const maxTokens = 120;
    const refillPerMs = 60 / 1000;
    let bucket = this.rateBuckets.get(remoteIp);
    if (!bucket) {
      if (this.rateBuckets.size >= 10000) {
        const firstKey = this.rateBuckets.keys().next().value;
        if (firstKey !== undefined) this.rateBuckets.delete(firstKey);
      }
      bucket = { tokens: maxTokens - 1, lastRefillMs: now };
      this.rateBuckets.set(remoteIp, bucket);
      return true;
    }
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = now;
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket({
          type: 'udp4',
          reuseAddr: true,
          reusePort: true
        });

        const startupErrorHandler = (err: any) => {
          try { this.socket?.close(); } catch {}
          this.socket = null;

          console.error(formatPortError({
            serviceName: 'UDP DNS',
            protocol: 'UDP',
            port: this.options.port,
            err,
            alternateOption: '--dns-port <port> (e.g. --dns-port 5353)',
            disableOption: '--disable-udp'
          }));

          reject(err);
        };

        this.socket.once('error', startupErrorHandler);

        this.socket.on('message', async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          await this.handleMessage(msg, rinfo);
        });

        this.socket.bind(this.options.port, this.options.host, () => {
          this.socket?.removeListener('error', startupErrorHandler);
          this.socket?.on('error', (err: Error) => {
            console.error('[UDP DNS] Socket runtime error:', err);
          });
          // Boost OS UDP socket buffers to reduce packet drops under high DNS load (progressive scaling: 16MB -> 8MB -> 4MB)
          const candidateBufferSizes = [16 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024];
          for (const size of candidateBufferSizes) {
            try {
              this.socket?.setRecvBufferSize(size);
              this.socket?.setSendBufferSize(size);
              break;
            } catch {
              /* Gracefully fall through to next smaller buffer size if OS rmem_max restricts */
            }
          }
          this.isRunning = true;
          console.log(`[UDP DNS] Classic DNS listening on udp://${this.options.host}:${this.options.port}`);
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private async handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    try {
      if (msg.length < 12 || msg.length > 4096) {
        return; // Drop oversized or truncated DNS UDP packets
      }
      if (!this.allowUdpPacket(rinfo.address)) {
        return; // Drop excess UDP packets per source IP to prevent amplification / CPU DoS
      }
      const rawBytes = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      const query = parseDNSQueryFromRaw(rawBytes);
      if (!query) {
        return; // Drop invalid / malformed packets
      }

      const env = this.options.env;
      const ctx: ExecutionContext = {
        waitUntil(promise: Promise<any>) {
          promise.catch((err) => console.error('[UDP Background Task Error]:', err));
        },
        passThroughOnException() {}
      } as any;

      // Determine profile:
      // 1. Configured default profile key
      // 2. Safe default profile fallback to FAIL_OPEN_UPSTREAM (log_retention_days: 0)
      let profile = null;
      if (this.options.defaultProfileKey) {
        profile = await resolveProfileByKey(this.options.defaultProfileKey, env, ctx);
      }
      if (!profile) {
        profile = await resolveDefaultProfile(env, ctx);
      }
      if (!profile) {
        return;
      }

      const context: Context = {
        profileId: profile.id,
        accessPointId: profile.access_point_id,
        accessPointName: profile.access_point_name,
        startTime: Date.now(),
        env,
        ctx,
        isEmergencyFallback: Boolean(profile.isEmergencyFallback)
      };

      const host = rinfo.address.includes(':') ? `[${rinfo.address}]` : rinfo.address;
      const request = new Request(`http://${host}/${profile.profile_key || profile.id || 'default'}`, {
        headers: {
          'CF-Connecting-IP': rinfo.address,
          'Accept': 'application/dns-message',
          'Content-Type': 'application/dns-message'
        }
      });

      const result = await pipeline.process(request, query, context);
      if (!profile.isEmergencyFallback && profile.id !== 'default') {
        const activeDnsTtl = Number(env.ACTIVE_DNS_CACHE_TTL) || 60;
        ctx.waitUntil(recordActiveDnsConnection(null, rinfo.address, profile.id, activeDnsTtl, true));
      }
      if (!result || result.action === 'FAIL' || !result.answer || result.answer.length === 0) {
        if (!hasAlreadyTriedFailOpen(result, env)) {
          const fallbackRes = await resolveFailOpenFallback(env, rawBytes);
          if (fallbackRes.answer && fallbackRes.answer.length > 0) {
            this.sendUdpAnswer(fallbackRes.answer, rinfo);
          }
        }
        return;
      }

      this.sendUdpAnswer(result.answer, rinfo);
    } catch (err) {
      console.error('[UDP DNS] Message handling exception:', err);
      try {
        const rawBytes = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
        const transportRes = await resolveFailOpenFallback(this.options.env, rawBytes);
        if (transportRes.answer && transportRes.answer.length > 0) {
          this.sendUdpAnswer(transportRes.answer, rinfo);
        }
      } catch (fallbackErr) {
        console.error('[UDP DNS] Fail-open upstream fallback failed:', fallbackErr);
      }
    }
  }

  /**
   * Truncates oversized DNS responses to RFC 1035 512-byte UDP limit and transmits to client.
   */
  private sendUdpAnswer(rawAnswer: Uint8Array, rinfo: dgram.RemoteInfo): void {
    let answer = rawAnswer;
    // RFC 1035 UDP 512 bytes limit check (if no EDNS or response > 512, truncate)
    if (answer.length > 512) {
      const truncated = new Uint8Array(answer);
      // Set TC (Truncation) bit: flags byte 1 (offset 2) bit 1 (0x02)
      truncated[2] |= 0x02;
      answer = truncated.slice(0, 512);
    }

    this.socket?.send(answer, rinfo.port, rinfo.address, (err: Error | null) => {
      if (err) {
        console.warn(`[UDP DNS] Failed to send answer to ${rinfo.address}:${rinfo.port}:`, err.message);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket && this.isRunning) {
        this.socket.close(() => {
          this.isRunning = false;
          console.log('[UDP DNS] Service stopped.');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
