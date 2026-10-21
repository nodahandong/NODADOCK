// In-browser stand-in for the Rust backend, used by `npm run dev` outside
// Tauri so the UI can be developed and previewed without mounting anything.
// Add ?demo=empty or ?demo=unlock to the URL for other starting states.
import type { Drive, DriveView, Settings, Status, SystemInfo } from "./types";

const demo = new URLSearchParams(location.search).get("demo") ?? "full";
const os = (new URLSearchParams(location.search).get("os") ?? "windows") as SystemInfo["os"];
const listeners = new Map<string, Set<(p: unknown) => void>>();
const emit = (e: string, p: unknown = null) => listeners.get(e)?.forEach((cb) => cb(p));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base: Omit<Drive, "id" | "name" | "provider"> = {
  remotePath: "",
  mountPoint: "",
  autoMount: true,
  rememberPassword: true,
  readOnly: false,
  cacheMode: "full",
  networkMode: false,
  color: "",
};

let drives: DriveView[] =
  demo === "empty"
    ? []
    : [
        {
          ...base,
          id: "a",
          name: "Work Nextcloud",
          color: "#4f6bff",
          provider: { type: "webdav", url: "https://cloud.example.com/remote.php/dav/files/noda/", vendor: "nextcloud", username: "noda" },
          mountPoint: "Z:",
          status: "mounted",
          activeMountPoint: os === "windows" ? "Z:" : "/Users/noda/NodaDock/Work Nextcloud",
          uploads: 2,
        },
        {
          ...base,
          id: "b",
          name: "Google Drive",
          color: "#12b886",
          provider: { type: "gdrive", account: "noda@gmail.com", sharedDriveId: "", sharedDriveName: "", clientId: "" },
          status: "mounted",
          activeMountPoint: os === "windows" ? "Y:" : "/Users/noda/NodaDock/Google Drive",
          uploads: 0,
        },
        {
          ...base,
          id: "c",
          name: "NAS Backup",
          color: "#f08c00",
          rememberPassword: false,
          provider: { type: "webdav", url: "https://nas.local:5006/backup", vendor: "other", username: "admin" },
          status: "locked",
          uploads: 0,
        },
        {
          ...base,
          id: "d",
          name: "Team Shared",
          color: "#ae3ec9",
          autoMount: false,
          provider: { type: "gdrive", account: "noda@gmail.com", sharedDriveId: "x", sharedDriveName: "Marketing", clientId: "" },
          status: "unmounted",
          uploads: 0,
        },
      ];

let settings: Settings = {
  launchAtLogin: true,
  startMinimized: true,
  closeToTray: true,
  theme: "system",
  cacheMaxSizeGb: 10,
  macMountBackend: "auto",
};

const usage: Record<string, { total: number; used: number; free: number }> = {
  a: { total: 1e12, used: 3.42e11, free: 6.58e11 },
  b: { total: 1.6e10, used: 1.13e10, free: 4.7e9 },
};

const letters = ["E:", "F:", "G:", "H:", "K:", "M:", "P:", "W:", "X:", "Y:", "Z:"];

function setDrive(id: string, patch: Partial<DriveView>) {
  drives = drives.map((d) => (d.id === id ? { ...d, ...patch } : d));
  emit("status-changed");
}

export async function mockInvoke(cmd: string, a: Record<string, any> = {}): Promise<unknown> {
  switch (cmd) {
    case "get_status": {
      const mounted = drives.some((d) => d.status === "mounted");
      const s: Status = {
        engineReady: true,
        engineVersion: "v1.71.1",
        drives,
        speed: mounted ? 4.2e6 + Math.random() * 1e6 : 0,
        bytes: 1.84e9,
        transfers: mounted && demo !== "empty"
          ? [
              { name: "Projects/Q4 roadmap.pptx", size: 4.8e7, bytes: 3.1e7, percentage: 64, speed: 2.9e6 },
              { name: "Photos/2026/IMG_2231.HEIC", size: 3.2e6, bytes: 9e5, percentage: 28, speed: 1.3e6 },
            ]
          : [],
      };
      return s;
    }
    case "system_info":
      return {
        os,
        driver: os === "windows"
          ? { os, driver: "WinFsp", installed: true, installUrl: "https://winfsp.dev/rel/" }
          : { os, driver: "FUSE-T", installed: false, fallback: "Built-in NFS", installUrl: "https://www.fuse-t.org/" },
        freeLetters: letters,
        mountRoot: "/Users/noda/NodaDock",
        logFile: "C:\\Users\\Noda\\AppData\\Local\\app.nodadock.desktop\\logs\\rclone.log",
        cacheDir: "C:\\Users\\Noda\\AppData\\Local\\app.nodadock.desktop",
        appVersion: "0.1.0",
      } satisfies SystemInfo;
    case "get_settings":
      return settings;
    case "save_settings":
      settings = a.settings;
      return;
    case "save_drive": {
      const d: Drive = { ...a.drive, id: a.drive.id || Math.random().toString(36).slice(2) };
      const existing = drives.find((x) => x.id === d.id);
      if (existing) setDrive(d.id, d);
      else {
        drives = [...drives, { ...d, status: "unmounted", uploads: 0 }];
        emit("status-changed");
      }
      return d;
    }
    case "delete_drive":
      drives = drives.filter((d) => d.id !== a.id);
      emit("status-changed");
      return;
    case "mount_drive": {
      const d = drives.find((x) => x.id === a.id)!;
      if (d.status === "locked" && !a.password) throw "PASSWORD_REQUIRED";
      setDrive(a.id, { status: "mounting", error: null });
      await wait(900);
      if (a.password === "wrong") {
        setDrive(a.id, { status: "locked" });
        throw "The server didn't accept the username or password.";
      }
      const mp = d.mountPoint || (os === "windows" ? letters.find((l) => !drives.some((x) => x.activeMountPoint === l))! : `/Users/noda/NodaDock/${d.name}`);
      setDrive(a.id, { status: "mounted", activeMountPoint: mp, rememberPassword: d.rememberPassword || !!a.remember });
      return;
    }
    case "unmount_drive": {
      const d = drives.find((x) => x.id === a.id)!;
      if (d.uploads > 0 && !a.force) throw `PENDING_UPLOADS:${d.uploads}`;
      setDrive(a.id, { status: "unmounting" });
      await wait(600);
      setDrive(a.id, { status: d.rememberPassword || d.provider.type === "gdrive" ? "unmounted" : "unmounted", activeMountPoint: null, uploads: 0 });
      return;
    }
    case "mount_all":
      for (const d of drives) if (d.status === "unmounted") await mockInvoke("mount_drive", { id: d.id });
      return;
    case "unmount_all":
      for (const d of drives) if (d.status === "mounted") await mockInvoke("unmount_drive", { id: d.id, force: a.force });
      return;
    case "take_unlock_prompt":
      return demo === "unlock" ? drives.filter((d) => d.status === "locked").map((d) => d.id) : [];
    case "test_connection":
      await wait(800);
      if (a.password === "wrong") throw "The server didn't accept the username or password.";
      return { total: 5e11, used: 1.2e11, free: 3.8e11 };
    case "drive_usage":
      return usage[a.id] ?? {};
    case "google_sign_in":
      await wait(400);
      emit("google-auth-url", "http://127.0.0.1:53682/auth?state=demo");
      await wait(1800);
      return { token: '{"access_token":"demo"}', email: "noda@gmail.com" };
    case "google_shared_drives":
      return [
        { id: "x", name: "Marketing" },
        { id: "y", name: "Engineering" },
      ];
    case "quit_app":
      if (!a.force && drives.some((d) => d.uploads > 0)) throw "PENDING_UPLOADS:2";
      return;
    default:
      return;
  }
}

export function mockListen(event: string, cb: (p: unknown) => void): Promise<() => void> {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return Promise.resolve(() => listeners.get(event)!.delete(cb));
}
