export type Provider =
  | { type: "webdav"; url: string; vendor: string; username: string }
  | { type: "gdrive"; account: string; sharedDriveId: string; sharedDriveName: string; clientId: string };

export interface Drive {
  id: string;
  name: string;
  provider: Provider;
  remotePath: string;
  mountPoint: string;
  autoMount: boolean;
  rememberPassword: boolean;
  readOnly: boolean;
  cacheMode: "off" | "minimal" | "writes" | "full";
  networkMode: boolean;
  color: string;
}

export type DriveStatus = "mounted" | "mounting" | "unmounting" | "unmounted" | "error" | "locked";

export interface DriveView extends Drive {
  status: DriveStatus;
  error?: string | null;
  activeMountPoint?: string | null;
  uploads: number;
}

export interface Transfer {
  name: string;
  size: number;
  bytes: number;
  percentage: number;
  speed: number;
}

export interface Status {
  engineReady: boolean;
  engineVersion: string;
  engineError?: string | null;
  drives: DriveView[];
  speed: number;
  bytes: number;
  transfers: Transfer[];
}

export interface Settings {
  launchAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  theme: "system" | "light" | "dark";
  cacheMaxSizeGb: number;
  macMountBackend: "auto" | "fuse" | "nfs";
}

export interface SystemInfo {
  os: "windows" | "macos" | "linux";
  driver: { os: string; driver: string; installed: boolean; fallback?: string | null; installUrl?: string | null };
  freeLetters: string[];
  mountRoot: string;
  logFile: string;
  cacheDir: string;
  appVersion: string;
}

export interface Usage {
  total?: number | null;
  used?: number | null;
  free?: number | null;
}

export interface SharedDrive {
  id: string;
  name: string;
}
