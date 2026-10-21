import type { Drive, SystemInfo } from "./types";

export function formatBytes(n?: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? digits : 0)} ${units[i]}`;
}

export function formatSpeed(bps: number): string {
  return bps < 1 ? "0 B/s" : `${formatBytes(bps)}/s`;
}

export const COLORS = ["#4f6bff", "#12b886", "#f08c00", "#e64980", "#ae3ec9", "#1c7ed6", "#495057"];

export function driveColor(d: Drive, index = 0): string {
  return d.color || COLORS[index % COLORS.length];
}

export function subtitle(d: Drive): string {
  if (d.provider.type === "gdrive") {
    const where = d.provider.sharedDriveName || "My Drive";
    return d.provider.account ? `${d.provider.account} · ${where}` : where;
  }
  try {
    const u = new URL(d.provider.url);
    return d.provider.username ? `${d.provider.username}@${u.host}` : u.host;
  } catch {
    return d.provider.url;
  }
}

export function credentialStore(os: SystemInfo["os"] | undefined): string {
  return os === "windows" ? "Windows Credential Manager" : os === "macos" ? "macOS Keychain" : "the system keyring";
}

export function hostName(url: string): string {
  try {
    return new URL(url).hostname.split(".").filter((p) => !["www", "cloud", "dav", "webdav"].includes(p))[0] ?? "";
  } catch {
    return "";
  }
}
