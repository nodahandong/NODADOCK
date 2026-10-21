import { useState } from "react";
import { api, errText } from "../api";
import type { DriveView, SystemInfo } from "../types";
import { credentialStore, subtitle } from "../util";
import { Icon, ProviderIcon } from "./Icons";
import { Modal, PasswordInput, Spinner } from "./ui";

/** Asks for the passwords of drives set to "ask every time". */
export function UnlockDialog({ drives, info, colorOf, onClose }: {
  drives: DriveView[];
  info: SystemInfo | null;
  colorOf: (d: DriveView) => string;
  onClose: () => void;
}) {
  const [ids] = useState(() => drives.map((d) => d.id));
  const [pw, setPw] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [remember, setRemember] = useState(false);

  const rows = ids.map((id) => drives.find((d) => d.id === id)).filter(Boolean) as DriveView[];

  async function unlock(id: string) {
    if (!pw[id]) return;
    setBusy((b) => ({ ...b, [id]: true }));
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      await api.mount(id, pw[id], remember);
      setDone((d) => ({ ...d, [id]: true }));
      setPw((p) => ({ ...p, [id]: "" }));
      const left = ids.filter((x) => x !== id && !done[x]);
      if (left.length === 0) setTimeout(onClose, 500);
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: errText(e) }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  const pending = ids.filter((id) => !done[id] && pw[id]);

  return (
    <Modal width={520} onClose={onClose}
      title={<span className="unlock-title"><span className="unlock-badge"><Icon.Lock size={18} /></span>Unlock your drives</span>}
      subtitle={rows.length > 1 ? "These drives are set to ask for their password when CloudDock starts." : "This drive is set to ask for its password when CloudDock starts."}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember from now on
          </label>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>Not now</button>
          {rows.length > 1 && (
            <button className="btn primary" disabled={pending.length === 0} onClick={() => pending.forEach(unlock)}>
              <Icon.Unlock size={16} />Unlock all
            </button>
          )}
        </>
      }>
      <div className="unlock-list">
        {rows.map((d, i) => (
          <div key={d.id} className={`unlock-row ${done[d.id] ? "done" : ""}`} style={{ ["--drive" as string]: colorOf(d) }}>
            <div className="drive-tile small"><ProviderIcon type={d.provider.type} size={18} /></div>
            <div className="unlock-main">
              <div className="unlock-name"><b>{d.name}</b><span className="muted ellipsis">{subtitle(d)}</span></div>
              {done[d.id] ? (
                <span className="ok-text"><Icon.Check size={16} />Connected</span>
              ) : (
                <div className="unlock-input">
                  <PasswordInput value={pw[d.id] ?? ""} onChange={(v) => setPw((p) => ({ ...p, [d.id]: v }))}
                    placeholder="Password" autoFocus={i === 0} onEnter={() => unlock(d.id)} />
                  <button className="btn primary" disabled={!pw[d.id] || busy[d.id]} onClick={() => unlock(d.id)}>
                    {busy[d.id] ? <Spinner /> : "Unlock"}
                  </button>
                </div>
              )}
              {errors[d.id] && <span className="err-text">{errors[d.id]}</span>}
            </div>
          </div>
        ))}
      </div>
      {remember && <p className="muted small">Passwords will be saved in {credentialStore(info?.os)} and these drives will connect on their own next time.</p>}
    </Modal>
  );
}
