import { useEffect, useState } from "react";
import { api } from "../api";
import type { DriveView, Usage } from "../types";
import { formatBytes, subtitle } from "../util";
import { Icon, ProviderIcon } from "./Icons";
import { Menu, Spinner, Switch } from "./ui";

const STATUS: Record<DriveView["status"], { label: string; tone: string }> = {
  mounted: { label: "Connected", tone: "ok" },
  mounting: { label: "Connecting…", tone: "busy" },
  unmounting: { label: "Disconnecting…", tone: "busy" },
  unmounted: { label: "Not connected", tone: "off" },
  error: { label: "Couldn't connect", tone: "bad" },
  locked: { label: "Password needed", tone: "warn" },
};

export function DriveCard({ drive, color, onToggle, onUnlock, onEdit, onRemove }: {
  drive: DriveView;
  color: string;
  onToggle: (on: boolean) => void;
  onUnlock: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const mounted = drive.status === "mounted";
  const busy = drive.status === "mounting" || drive.status === "unmounting";

  useEffect(() => {
    if (!mounted) return setUsage(null);
    let alive = true;
    const load = () => api.usage(drive.id).then((u) => alive && setUsage(u)).catch(() => {});
    const t1 = setTimeout(load, 1500);
    const t2 = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearTimeout(t1); clearInterval(t2); };
  }, [mounted, drive.id]);

  const s = STATUS[drive.status];
  const pct = usage?.total && usage.used != null ? Math.min(100, (usage.used / usage.total) * 100) : null;
  const where = drive.activeMountPoint ?? (drive.mountPoint || "Auto");
  const shortWhere = where.length > 3 ? where.split(/[\\/]/).pop() : where;

  return (
    <article className={`drive-card ${mounted ? "is-on" : ""}`} style={{ ["--drive" as string]: color }}>
      <div className="drive-top">
        <div className="drive-tile"><ProviderIcon type={drive.provider.type} /></div>
        <div className="drive-id">
          <h3 title={drive.name}>{drive.name}</h3>
          <p className="muted ellipsis" title={subtitle(drive)}>{subtitle(drive)}</p>
        </div>
        {drive.status === "locked" ? (
          <button className="btn small warn" onClick={onUnlock}><Icon.Lock size={14} />Unlock</button>
        ) : (
          <Switch checked={mounted || drive.status === "mounting"} disabled={busy} label={mounted ? "Disconnect" : "Connect"}
            onChange={onToggle} />
        )}
      </div>

      <div className="drive-mid">
        <span className={`pill ${s.tone}`}>
          {busy ? <Spinner size={10} /> : <i className="dot" />}
          {s.label}
        </span>
        <span className="letter" title={where}>{shortWhere}</span>
        {drive.readOnly && <span className="tag">Read-only</span>}
        {!drive.rememberPassword && drive.provider.type === "webdav" && <span className="tag" title="Asks for the password at startup"><Icon.Lock size={11} />Ask</span>}
      </div>

      {drive.status === "error" && drive.error && <p className="drive-error"><Icon.Alert size={14} />{drive.error}</p>}

      {mounted && (
        <div className="usage">
          <div className="bar"><span style={{ width: `${pct ?? 0}%` }} className={pct == null ? "unknown" : pct > 90 ? "full" : ""} /></div>
          <div className="usage-row muted">
            <span>{pct != null ? `${formatBytes(usage!.used)} of ${formatBytes(usage!.total)}` : usage ? "Storage size not reported" : "Checking space…"}</span>
            {drive.uploads > 0 && <span className="uploading"><Icon.Upload size={12} />{drive.uploads} uploading</span>}
          </div>
        </div>
      )}

      <div className="drive-actions">
        <button className="btn soft" disabled={!mounted} onClick={() => api.open(drive.id)}>
          <Icon.Folder size={16} />Open
        </button>
        <span className="grow" />
        <Menu items={[
          { label: "Edit drive", icon: <Icon.Edit size={15} />, onClick: onEdit },
          { label: "Remove drive", icon: <Icon.Trash size={15} />, danger: true, onClick: onRemove },
        ]} />
      </div>
    </article>
  );
}
