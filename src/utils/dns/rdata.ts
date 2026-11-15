import { encodeHttpsRDataFromString } from "../ech";

/**
 * Encodes string record values (like IPs, domains, texts, HTTPS/SVCB) into standard DNS RDATA byte segments.
 *
 * @param type - The DNS record type.
 * @param value - The payload value to encode.
 * @returns A number array representing encoded RDATA bytes.
 */
export function encodeRData(type: string, value: string): number[] {
  let data: number[] = [];
  if (type === "A") {
    const parts = value.split(".");
    if (parts.length !== 4) {
      throw new Error(`Invalid IPv4 address for A record: ${value}`);
    }
    data = parts.map((v) => {
      if (!/^\d{1,3}$/.test(v)) throw new Error(`Invalid IPv4 octet: ${v}`);
      const num = parseInt(v, 10);
      if (num < 0 || num > 255) throw new Error(`IPv4 octet out of range: ${v}`);
      return num;
    });
  } else if (type === "AAAA") {
    const bytes = new Uint8Array(16).fill(0);
    if (value.includes("::")) {
      const halves = value.split("::");
      if (halves.length > 2) {
        throw new Error(`Invalid IPv6 address: ${value}`);
      }
      const [left, right] = halves;
      const leftParts = left ? left.split(":") : [];
      const rightParts = right ? right.split(":") : [];
      if (leftParts.length + rightParts.length > 7) {
        throw new Error(`Invalid IPv6 group count: ${value}`);
      }

      let i = 0;
      for (const part of leftParts) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) throw new Error(`Invalid IPv6 group: ${part}`);
        const v = parseInt(part, 16);
        bytes[i++] = (v >> 8) & 0xff;
        bytes[i++] = v & 0xff;
      }

      i = 16 - rightParts.length * 2;
      for (const part of rightParts) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) throw new Error(`Invalid IPv6 group: ${part}`);
        const v = parseInt(part, 16);
        bytes[i++] = (v >> 8) & 0xff;
        bytes[i++] = v & 0xff;
      }
    } else {
      const parts = value.split(":");
      if (parts.length !== 8) {
        throw new Error(`Invalid IPv6 address: ${value}`);
      }
      let i = 0;
      for (const part of parts) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) throw new Error(`Invalid IPv6 group: ${part}`);
        const v = parseInt(part, 16);
        bytes[i++] = (v >> 8) & 0xff;
        bytes[i++] = v & 0xff;
      }
    }
    data = Array.from(bytes);
  } else if (type === "CNAME") {
    const labels = value.replace(/\.$/, "").split(".").filter(Boolean);
    for (const label of labels) {
      if (label.length > 63) {
        throw new Error(`CNAME label exceeds 63 octets: ${label}`);
      }
      data.push(label.length);
      for (let i = 0; i < label.length; i++) data.push(label.charCodeAt(i));
    }
    data.push(0);
  } else if (type === "TXT") {
    for (let i = 0; i < value.length; i += 255) {
      const chunk = value.substring(i, i + 255);
      data.push(chunk.length);
      for (let j = 0; j < chunk.length; j++) {
        data.push(chunk.charCodeAt(j));
      }
    }
    if (data.length > 65535) {
      throw new Error("TXT RDATA exceeds 65535 bytes");
    }
  } else if (type === "HTTPS" || type === "SVCB") {
    data = encodeHttpsRDataFromString(value);
  }
  return data;
}
