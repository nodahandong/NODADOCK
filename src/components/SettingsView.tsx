import type { ReactNode } from "react";
import { api } from "../api";
import type { Settings, Status, SystemInfo } from "../types";
import { Icon } from "./Icons";
import { Segmented, Switch } from "./ui";

export function SettingsView({ settings, onChange, info, status }: {
  settings: Settings | null;
  onChange: (s: Settings) => void;
  info: SystemInfo | null;
  status: Status | null;
}) {
  if (!settings) return null;
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const drv = info?.driver;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">CloudDock works without an account. Everything stays on this computer.</p>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Startup</h2>
        <Row title="Start CloudDock when I sign in" desc="Your drives reconnect by themselves after every restart.">
          <Switch checked={settings.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} label="Launch at login" />
        </Row>
        <Row title="Start quietly in the background" desc={`Open in the ${info?.os === "macos" ? "menu bar" : "system tray"} instead of showing this window. You'll still be asked for any passwords that aren't saved.`}>
          <Switch checked={settings.startMinimized} onChange={(v) => set({ startMinimized: v })} label="Start minimized" />
        </Row>
        <Row title="Keep drives connected when I close this window" desc="Closing the window leaves CloudDock running so your drives stay available.">
          <Switch checked={settings.closeToTray} onChange={(v) => set({ closeToTray: v })} label="Close to tray" />
        </Row>
      </section>

      <section className="card">
        <h2 className="card-title">Appearance</h2>
        <Row title="Theme">
          <Segmented value={settings.theme} onChange={(v) => set({ theme: v })}
            options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Row>
      </section>

      <section className="card">
        <h2 className="card-title">Cache</h2>
        <Row title="Maximum cache size" desc="Space CloudDock may use on this computer for files you've opened. Older files are cleared first. Applies the next time a drive connects.">
          <select className="compact" value={settings.cacheMaxSizeGb} onChange={(e) => set({ cacheMaxSizeGb: Number(e.target.value) })}>
            {[2, 5, 10, 20, 50, 100, 250].map((n) => <option key={n} value={n}>{n} GB</option>)}
          </select>
        </Row>
        {info?.os === "macos" && (
          <Row title="Mount method" desc="Automatic uses FUSE-T or macFUSE when installed, and macOS's built-in NFS otherwise (nothing to install).">
            <Segmented value={settings.macMountBackend} onChange={(v) => set({ macMountBackend: v })}
              options={[{ value: "auto", label: "Automatic" }, { value: "fuse", label: "FUSE" }, { value: "nfs", label: "NFS" }]} />
          </Row>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">System</h2>
        {drv && (
          <Row title={`${drv.driver} file-system driver`}
            desc={drv.installed ? "Installed. Drives appear in " + (info?.os === "windows" ? "File Explorer." : "Finder.")
              : drv.fallback ? `Not installed. CloudDock is using ${drv.fallback} instead, which works without it.`
              : `Required to show drives in File Explorer. It's free and takes a minute to install.`}>
            {drv.installed ? (
              <span className="pill ok"><i className="dot" />Ready</span>
            ) : drv.installUrl ? (
              <button className={`btn ${drv.fallback ? "soft" : "primary"} small`} onClick={() => api.openUrl(drv.installUrl!)}>
                Get {drv.driver}<Icon.External size={14} />
              </button>
            ) : null}
          </Row>
        )}
        <Row title="Drive engine" desc={status?.engineError ?? (status?.engineReady ? `rclone ${status.engineVersion} is running.` : "Starting…")}>
          <button className="btn soft small" onClick={() => api.restartEngine()}><Icon.Refresh size={14} />Restart</button>
        </Row>
        <Row title="Logs" desc="Useful when a drive won't connect.">
          <button className="btn soft small" onClick={() => api.openLogs()}><Icon.Folder size={14} />Show log file</button>
        </Row>
      </section>

      <p className="muted small center">CloudDock {info?.appVersion} · Powered by rclone · Your passwords never leave this computer except to sign in to your own servers.</p>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <b>{title}</b>
        {desc && <span className="muted">{desc}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
