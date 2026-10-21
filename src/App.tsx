import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errText, on, pendingUploads } from "./api";
import { ActivityView } from "./components/ActivityView";
import { DriveCard } from "./components/DriveCard";
import { DriveWizard } from "./components/DriveWizard";
import { Icon } from "./components/Icons";
import { SettingsView } from "./components/SettingsView";
import { Confirm, type ConfirmSpec } from "./components/ui";
import { UnlockDialog } from "./components/UnlockDialog";
import type { Drive, DriveView, Settings, Status, SystemInfo } from "./types";
import { driveColor, formatSpeed } from "./util";

type View = "drives" | "activity" | "settings";
interface Toast { id: number; text: string; tone: "bad" | "ok" }

export default function App() {
  const [view, setView] = useState<View>("drives");
  const [status, setStatus] = useState<Status | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [wizard, setWizard] = useState<{ drive?: Drive } | null>(null);
  const [unlockIds, setUnlockIds] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((text: string, tone: Toast["tone"] = "bad") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const refresh = useCallback(() => api.status().then(setStatus).catch(() => {}), []);

  useEffect(() => {
    refresh();
    api.systemInfo().then(setInfo);
    api.getSettings().then(setSettings);
    const t = setInterval(refresh, 1500);
    const offs: Promise<() => void>[] = [
      on("status-changed", refresh),
      on("unlock-needed", () => api.takeUnlockPrompt().then((ids) => ids.length && setUnlockIds(ids))),
      on<number>("quit-blocked", (n) => askQuit(n)),
      on<string>("unmount-blocked", (id) => askForceUnmount(id)),
    ];
    // Covers the case where the backend finished auto-mounting before we loaded.
    setTimeout(() => api.takeUnlockPrompt().then((ids) => ids.length && setUnlockIds(ids)), 800);
    return () => { clearInterval(t); offs.forEach((p) => p.then((off) => off())); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme
  useEffect(() => {
    const root = document.documentElement;
    if (!settings || settings.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
  }, [settings?.theme]);

  const drives = status?.drives ?? [];
  const drivesRef = useRef(drives);
  drivesRef.current = drives;
  const colorOf = (d: DriveView | Drive) => driveColor(d, drives.findIndex((x) => x.id === d.id));

  function askQuit(n: number) {
    setConfirm({
      title: "Files are still uploading",
      body: <p>{n} file{n === 1 ? " is" : "s are"} still uploading. If you quit now, {n === 1 ? "it" : "they"} will finish uploading the next time the drive connects.</p>,
      confirm: "Quit anyway",
      cancel: "Keep running",
      danger: true,
      onConfirm: () => api.quit(true),
    });
  }

  function askForceUnmount(id: string, n?: number) {
    const d = drivesRef.current.find((x) => x.id === id);
    setConfirm({
      title: `Disconnect ${d?.name ?? "drive"}?`,
      body: (() => {
        const count = n ?? d?.uploads ?? 0;
        const one = count === 1;
        return <p>{count || "Some"} file{one ? " is" : "s are"} still uploading. {one ? "It's" : "They're"} safe on this computer and will finish uploading the next time you connect this drive.</p>;
      })(),
      confirm: "Disconnect anyway",
      cancel: "Wait",
      onConfirm: () => api.unmount(id, true).catch((e) => toast(errText(e))),
    });
  }

  async function toggle(d: DriveView, onNow: boolean) {
    try {
      if (onNow) await api.mount(d.id);
      else await api.unmount(d.id);
    } catch (e) {
      const n = pendingUploads(e);
      if (n != null) return askForceUnmount(d.id, n);
      if (errText(e) === "PASSWORD_REQUIRED") return setUnlockIds([d.id]);
      toast(`${d.name}: ${errText(e)}`);
    }
    refresh();
  }

  function remove(d: DriveView) {
    setConfirm({
      title: `Remove ${d.name}?`,
      body: <p>The drive is disconnected and its saved password or sign-in is deleted from this computer. Your files on the server are not touched.</p>,
      confirm: "Remove drive",
      danger: true,
      onConfirm: () => api.deleteDrive(d.id).catch((e) => toast(errText(e))),
    });
  }

  async function onSaved(saved: Drive, connect: boolean) {
    const wasMounted = drives.find((x) => x.id === saved.id)?.status === "mounted";
    setWizard(null);
    await refresh();
    try {
      if (wasMounted) {
        await api.unmount(saved.id);
        await api.mount(saved.id);
        toast("Changes saved and drive reconnected.", "ok");
      } else if (connect) {
        await api.mount(saved.id);
      }
    } catch (e) {
      if (pendingUploads(e) != null) toast("Changes saved. They'll apply after the current uploads finish and you reconnect.", "ok");
      else if (errText(e) === "PASSWORD_REQUIRED") setUnlockIds([saved.id]);
      else toast(`${saved.name}: ${errText(e)}`);
    }
    refresh();
  }

  async function saveSettings(s: Settings) {
    setSettings(s);
    try { await api.saveSettings(s); } catch (e) { toast(errText(e)); }
  }

  const connected = drives.filter((d) => d.status === "mounted").length;
  const locked = drives.filter((d) => d.status === "locked");
  const showDriverBanner = info && !info.driver.installed && !info.driver.fallback;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.svg" alt="" width={30} height={30} />
          <span>CloudDock</span>
        </div>
        <nav>
          <NavItem icon={<Icon.Drives />} label="Drives" active={view === "drives"} onClick={() => setView("drives")} badge={drives.length || undefined} />
          <NavItem icon={<Icon.Activity />} label="Activity" active={view === "activity"} onClick={() => setView("activity")}
            badge={status && status.transfers.length > 0 ? status.transfers.length : undefined} />
          <NavItem icon={<Icon.Settings />} label="Settings" active={view === "settings"} onClick={() => setView("settings")} />
        </nav>
        <div className="grow" />
        <div className="side-status">
          <div className="side-line">
            <i className={`dot ${status?.engineReady ? (connected ? "ok" : "off") : status?.engineError ? "bad" : "busy"}`} />
            {status?.engineError ? "Engine stopped" : !status?.engineReady ? "Starting…" : connected ? `${connected} connected` : "No drives connected"}
          </div>
          {status && status.speed > 1 && <div className="side-line muted"><Icon.Activity size={13} />{formatSpeed(status.speed)}</div>}
        </div>
      </aside>

      <main className="content">
        {status?.engineError && (
          <div className="banner bad"><Icon.Alert size={16} /><span>{status.engineError}</span>
            <button className="btn small soft" onClick={() => api.restartEngine()}>Try again</button></div>
        )}
        {showDriverBanner && (
          <div className="banner warn">
            <Icon.Alert size={16} />
            <span>{info!.driver.driver} is needed to show drives in {info!.os === "windows" ? "File Explorer" : "your file manager"}. It's free and installs in a minute.</span>
            {info!.driver.installUrl && <button className="btn small primary" onClick={() => api.openUrl(info!.driver.installUrl!)}>Get {info!.driver.driver}</button>}
          </div>
        )}

        {view === "drives" && (
          <div className="page">
            <header className="page-head">
              <div>
                <h1>Your drives</h1>
                <p className="muted">
                  {drives.length === 0 ? "Connect a WebDAV server or Google Drive and use it like a normal disk."
                    : `${connected} of ${drives.length} connected`}
                </p>
              </div>
              <div className="head-actions">
                {locked.length > 0 && (
                  <button className="btn warn" onClick={() => setUnlockIds(locked.map((d) => d.id))}><Icon.Lock size={16} />Unlock {locked.length}</button>
                )}
                {drives.length > 0 && <button className="btn primary" onClick={() => setWizard({})}><Icon.Plus size={16} />Add drive</button>}
              </div>
            </header>

            {status && drives.length === 0 ? (
              <div className="empty">
                <div className="empty-art"><img src="/logo.svg" alt="" width={84} height={84} /></div>
                <h2>Add your first drive</h2>
                <p className="muted">It shows up in {info?.os === "macos" ? "Finder" : "File Explorer"} {info?.os === "windows" ? "with its own drive letter" : "like any other disk"}, and reconnects by itself every time you start your computer. No account needed.</p>
                <button className="btn primary big" onClick={() => setWizard({})}><Icon.Plus size={18} />Add a drive</button>
              </div>
            ) : (
              <div className="grid">
                {drives.map((d) => (
                  <DriveCard key={d.id} drive={d} color={colorOf(d)}
                    onToggle={(v) => toggle(d, v)}
                    onUnlock={() => setUnlockIds([d.id])}
                    onEdit={() => setWizard({ drive: d })}
                    onRemove={() => remove(d)} />
                ))}
                {drives.length > 0 && (
                  <button className="add-card" onClick={() => setWizard({})}>
                    <span className="add-plus"><Icon.Plus size={22} /></span>
                    Add drive
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {view === "activity" && <ActivityView status={status} colorOf={(id) => { const d = drives.find((x) => x.id === id); return d ? colorOf(d) : "#888"; }} />}
        {view === "settings" && <SettingsView settings={settings} onChange={saveSettings} info={info} status={status} />}
      </main>

      {wizard && (
        <DriveWizard existing={wizard.drive} info={info} driveCount={drives.length}
          onClose={() => { api.googleCancel(); setWizard(null); }} onSaved={onSaved} />
      )}
      {unlockIds && unlockIds.length > 0 && (
        <UnlockDialog drives={drives.filter((d) => unlockIds.includes(d.id))} info={info} colorOf={colorOf}
          onClose={() => { setUnlockIds(null); refresh(); }} />
      )}
      {confirm && <Confirm spec={confirm} onClose={() => setConfirm(null)} />}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "ok" ? <Icon.Check size={16} /> : <Icon.Alert size={16} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, onClick, badge }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      {icon}<span>{label}</span>{badge != null && <span className="nav-badge">{badge}</span>}
    </button>
  );
}
