import type { Drive, SharedDrive, Settings, Status, SystemInfo, Usage } from "./types";
import { mockInvoke, mockListen } from "./mock";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) return mockInvoke(cmd, args) as Promise<T>;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!inTauri) return mockListen(event, cb as (p: unknown) => void);
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

export interface Secrets {
  password?: string;
  token?: string;
  clientSecret?: string;
}

export const api = {
  status: () => call<Status>("get_status"),
  systemInfo: () => call<SystemInfo>("system_info"),
  getSettings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  saveDrive: (drive: Drive, s: Secrets) => call<Drive>("save_drive", { drive, ...s }),
  deleteDrive: (id: string) => call<void>("delete_drive", { id }),
  mount: (id: string, password?: string, remember?: boolean) => call<void>("mount_drive", { id, password, remember }),
  unmount: (id: string, force = false) => call<void>("unmount_drive", { id, force }),
  mountAll: () => call<void>("mount_all"),
  unmountAll: (force = false) => call<void>("unmount_all", { force }),
  takeUnlockPrompt: () => call<string[]>("take_unlock_prompt"),
  test: (drive: Drive, s: Secrets) => call<Usage>("test_connection", { drive, ...s }),
  usage: (id: string) => call<Usage>("drive_usage", { id }),
  open: (id: string) => call<void>("open_drive", { id }),
  openLogs: () => call<void>("open_logs"),
  openUrl: (url: string) => call<void>("open_url", { url }),
  signIn: (backend: string, clientId: string, clientSecret: string) =>
    call<{ token: string; email?: string | null; options: Record<string, string> }>("cloud_sign_in", { backend, clientId, clientSecret }),
  googleCancel: () => call<void>("google_cancel"),
  googleSharedDrives: (token: string) => call<SharedDrive[]>("google_shared_drives", { token }),
  quit: (force: boolean) => call<void>("quit_app", { force }),
  restartEngine: () => call<void>("restart_engine"),
};

/** Backend errors are plain strings; some carry a machine-readable prefix. */
export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export function pendingUploads(e: unknown): number | null {
  const m = /^PENDING_UPLOADS:(\d+)/.exec(errText(e));
  return m ? Number(m[1]) : null;
}
