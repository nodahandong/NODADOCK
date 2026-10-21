import type { Status } from "../types";
import { formatBytes, formatSpeed } from "../util";
import { Icon } from "./Icons";

export function ActivityView({ status, colorOf }: { status: Status | null; colorOf: (id: string) => string }) {
  const transfers = status?.transfers ?? [];
  const pending = (status?.drives ?? []).filter((d) => d.uploads > 0);
  const connected = (status?.drives ?? []).filter((d) => d.status === "mounted").length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Live transfers across all your drives.</p>
        </div>
      </header>

      <div className="stats">
        <div className="stat"><span className="muted">Current speed</span><b>{formatSpeed(status?.speed ?? 0)}</b></div>
        <div className="stat"><span className="muted">Transferred this session</span><b>{formatBytes(status?.bytes ?? 0)}</b></div>
        <div className="stat"><span className="muted">Connected drives</span><b>{connected}</b></div>
      </div>

      {pending.length > 0 && (
        <section className="card">
          <h2 className="card-title">Waiting to upload</h2>
          {pending.map((d) => (
            <div key={d.id} className="pending-row">
              <i className="dot" style={{ background: colorOf(d.id) }} />
              <b>{d.name}</b>
              <span className="muted">{d.uploads} file{d.uploads === 1 ? "" : "s"} saved on this computer, uploading in the background</span>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Transferring now</h2>
        {transfers.length === 0 ? (
          <div className="empty small"><Icon.Activity size={28} /><p className="muted">Nothing is transferring right now.</p></div>
        ) : (
          transfers.map((t) => (
            <div key={t.name} className="transfer">
              <div className="transfer-row">
                <span className="ellipsis" title={t.name}>{t.name}</span>
                <span className="muted">{formatBytes(t.bytes)} / {formatBytes(t.size)} · {formatSpeed(t.speed)}</span>
              </div>
              <div className="bar thin"><span style={{ width: `${t.percentage}%` }} /></div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
