import { useEffect, useState } from "react";
import { api, errText, on } from "../api";
import type { Drive, SharedDrive, SystemInfo, Usage } from "../types";
import { COLORS, credentialStore, formatBytes, hostName } from "../util";
import { Icon } from "./Icons";
import { Field, Modal, PasswordInput, Segmented, Spinner, Switch } from "./ui";

const VENDORS = [
  { value: "other", label: "Standard WebDAV" },
  { value: "nextcloud", label: "Nextcloud" },
  { value: "owncloud", label: "ownCloud" },
  { value: "sharepoint-ntlm", label: "SharePoint (on-premises)" },
  { value: "fastmail", label: "Fastmail Files" },
  { value: "rclone", label: "rclone serve webdav" },
];

const CACHE = [
  { value: "full", label: "Smart cache", hint: "Best for everyday use. Files you open are cached on this computer, so Office, photo apps and previews work smoothly." },
  { value: "writes", label: "Writes only", hint: "Reads stream from the server; files you save are cached until they finish uploading." },
  { value: "minimal", label: "Streaming", hint: "Uses the least disk space. Some apps that edit files in place may not work." },
] as const;

function newDrive(type: "webdav" | "gdrive", index: number): Drive {
  return {
    id: "",
    name: "",
    provider: type === "webdav"
      ? { type, url: "", vendor: "other", username: "" }
      : { type, account: "", sharedDriveId: "", sharedDriveName: "", clientId: "" },
    remotePath: "",
    mountPoint: "",
    autoMount: true,
    rememberPassword: true,
    readOnly: false,
    cacheMode: "full",
    networkMode: false,
    color: COLORS[index % COLORS.length],
  };
}

export function DriveWizard({ existing, info, driveCount, onClose, onSaved }: {
  existing?: Drive;
  info: SystemInfo | null;
  driveCount: number;
  onClose: () => void;
  onSaved: (d: Drive, connect: boolean) => void;
}) {
  const editing = !!existing;
  const [step, setStep] = useState(editing ? 1 : 0);
  const [d, setD] = useState<Drive>(existing ?? newDrive("webdav", driveCount));
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | undefined>();
  const [clientSecret, setClientSecret] = useState<string | undefined>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [shared, setShared] = useState<SharedDrive[]>([]);
  const [saving, setSaving] = useState(false);

  const p = d.provider;
  const [parts, setPartsState] = useState<UrlParts>(() => splitUrl(p.type === "webdav" ? p.url : ""));
  const setParts = (next: UrlParts) => {
    setPartsState(next);
    setProv({ url: joinUrl(next) });
  };
  // Pasting a full link into the address box fills in every field.
  const setHost = (value: string) => {
    if (/^https?:\/\//i.test(value.trim())) {
      const sp = splitUrl(value.trim());
      if (sp.host) return setParts(sp);
    }
    setParts({ ...parts, host: value.replace(/\/+$/, "").trim() });
  };
  const set = (patch: Partial<Drive>) => { setD((x) => ({ ...x, ...patch })); setError(null); };
  const setProv = (patch: Record<string, string>) => {
    setD((x) => ({ ...x, provider: { ...x.provider, ...patch } as Drive["provider"] }));
    setTested(null);
    setError(null);
  };
  const os = info?.os;

  useEffect(() => {
    let off: (() => void) | undefined;
    on<string>("google-auth-url", setAuthUrl).then((f) => (off = f));
    return () => off?.();
  }, []);

  const secrets = () => ({ password: password || undefined, token, clientSecret });

  async function signIn() {
    if (p.type !== "gdrive") return;
    setSigningIn(true);
    setError(null);
    setAuthUrl(null);
    try {
      const r = await api.googleSignIn(p.clientId, clientSecret ?? "");
      setToken(r.token);
      setProv({ account: r.email ?? "" });
      api.googleSharedDrives(r.token).then(setShared).catch(() => {});
      // Make sure the new sign-in can actually read the drive.
      setTesting(true);
      try {
        setTested(await api.test({ ...d, provider: { ...p, account: r.email ?? "" } }, { token: r.token, clientSecret }));
      } catch (e) {
        setError(`Signed in, but Google Drive couldn't be opened: ${errText(e)}`);
      } finally {
        setTesting(false);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setSigningIn(false);
    }
  }

  async function next() {
    if (step === 1) {
      if (p.type === "webdav") {
        if (!parts.host.trim()) return setError("Enter the server address.");
        if (parts.port && (Number(parts.port) < 1 || Number(parts.port) > 65535)) return setError("The port must be a number from 1 to 65535.");
        if (!tested) {
          setTesting(true);
          try {
            setTested(await api.test(d, secrets()));
          } catch (e) {
            setTesting(false);
            return setError(errText(e));
          }
          setTesting(false);
        }
        if (!d.name) set({ name: capitalize(hostName(p.url)) || "My WebDAV" });
      } else {
        if (!token && !editing) return setError("Sign in with Google to continue.");
        if (!d.name) set({ name: p.sharedDriveName || "Google Drive" });
      }
    }
    setStep(step + 1);
  }

  async function save(connect: boolean) {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveDrive(d, secrets());
      onSaved(saved, connect);
    } catch (e) {
      setError(errText(e));
      setSaving(false);
    }
  }

  const title = editing ? `Edit ${existing!.name}` : ["Add a drive", "Connect to your storage", "Set up your drive"][step];
  const steps = ["Service", "Connection", "Drive"];

  const footer = (
    <>
      {step > (editing ? 1 : 0) && (
        <button className="btn ghost" onClick={() => { setStep(step - 1); setError(null); }}><Icon.Back size={16} />Back</button>
      )}
      <span className="grow" />
      {step === 1 && (
        <>
          {p.type === "webdav" && tested && <span className="ok-text"><Icon.Check size={16} />Connection works</span>}
          <button className="btn primary" onClick={next} disabled={testing || signingIn}>
            {testing ? <><Spinner />Checking…</> : "Continue"}
          </button>
        </>
      )}
      {step === 2 && (
        <>
          {editing ? (
            <button className="btn primary" onClick={() => save(false)} disabled={saving}>{saving ? <Spinner /> : null}Save changes</button>
          ) : (
            <>
              <button className="btn ghost" onClick={() => save(false)} disabled={saving}>Save only</button>
              <button className="btn primary" onClick={() => save(true)} disabled={saving}>{saving ? <Spinner /> : <Icon.Power size={16} />}Save and connect</button>
            </>
          )}
        </>
      )}
    </>
  );

  return (
    <Modal title={title} onClose={onClose} footer={step > 0 ? footer : undefined} width={600}
      subtitle={
        <span className="steps">
          {steps.map((s, i) => (
            <span key={s} className={i === step ? "active" : i < step ? "done" : ""}>{i < step ? <Icon.Check size={12} /> : <b>{i + 1}</b>}{s}</span>
          ))}
        </span>
      }>
      {step === 0 && (
        <div className="choose">
          <button className="choice" onClick={() => { setD(newDrive("webdav", driveCount)); setPartsState(splitUrl("")); setStep(1); }}>
            <span className="choice-icon webdav"><Icon.Server size={26} /></span>
            <span className="choice-text">
              <b>WebDAV server</b>
              <span className="muted">Nextcloud, ownCloud, Synology, QNAP, SharePoint, Box and any server that speaks WebDAV.</span>
            </span>
          </button>
          <button className="choice" onClick={() => { setD(newDrive("gdrive", driveCount)); setStep(1); }}>
            <span className="choice-icon gdrive"><Icon.GDrive size={26} /></span>
            <span className="choice-text">
              <b>Google Drive</b>
              <span className="muted">Your My Drive or a shared drive. Sign in once in your browser; no password is stored.</span>
            </span>
          </button>
        </div>
      )}

      {step === 1 && p.type === "webdav" && (
        <div className="form">
          <div className="row-server">
            <Field label="Protocol">
              <select value={parts.scheme} onChange={(e) => setParts({ ...parts, scheme: e.target.value })}>
                <option value="https">https://</option>
                <option value="http">http://</option>
              </select>
            </Field>
            <Field label="Server address">
              <input value={parts.host} onChange={(e) => setHost(e.target.value)} placeholder="files.example.com or 192.168.1.20"
                autoFocus spellCheck={false} />
            </Field>
            <Field label="Port">
              <input value={parts.port} onChange={(e) => setParts({ ...parts, port: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                placeholder={parts.scheme === "https" ? "443" : "80"} inputMode="numeric" />
            </Field>
          </div>
          <Field label="WebDAV path" hint={p.vendor === "nextcloud" || p.vendor === "owncloud"
            ? "For Nextcloud/ownCloud: /remote.php/dav/files/USERNAME/"
            : "Leave empty if WebDAV is at the root of the server. You can also paste a full https:// link into Server address."}>
            <input value={parts.path} onChange={(e) => setParts({ ...parts, path: e.target.value })} placeholder="/" spellCheck={false} />
          </Field>
          {p.url && <p className="muted small url-preview">Connects to <code>{p.url}</code></p>}
          <div className="row2">
            <Field label="Server type">
              <select value={p.vendor} onChange={(e) => setProv({ vendor: e.target.value })}>
                {VENDORS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Folder on server" hint="Leave empty for everything">
              <input value={d.remotePath} onChange={(e) => { set({ remotePath: e.target.value }); setTested(null); }} placeholder="/" spellCheck={false} />
            </Field>
          </div>
          <div className="row2">
            <Field label="Username">
              <input value={p.username} onChange={(e) => setProv({ username: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Password" hint={editing && d.rememberPassword ? "Leave empty to keep the saved password" : undefined}>
              <PasswordInput value={password} onChange={(v) => { setPassword(v); setTested(null); }} onEnter={next}
                placeholder={editing && d.rememberPassword ? "••••••••" : ""} />
            </Field>
          </div>
          {tested && (tested.total ? (
            <div className="note ok"><Icon.Check size={16} />Connected. {formatBytes(tested.free)} free of {formatBytes(tested.total)}.</div>
          ) : null)}
        </div>
      )}

      {step === 1 && p.type === "gdrive" && (
        <div className="form">
          {token || (editing && p.account) ? (
            <div className="signed-in">
              <span className="avatar">{(p.account || "G")[0].toUpperCase()}</span>
              <div>
                <b>{p.account || "Signed in"}</b>
                <span className="muted">{token ? "Signed in just now" : "Signed in"}</span>
              </div>
              <span className="grow" />
              <button className="btn ghost small" onClick={signIn} disabled={signingIn}>Switch account</button>
            </div>
          ) : (
            <div className="google-start">
              <button className="btn google" onClick={signIn} disabled={signingIn}>
                {signingIn ? <Spinner /> : <Icon.GDrive size={18} />}
                {signingIn ? "Waiting for your browser…" : "Sign in with Google"}
              </button>
              {signingIn ? (
                <div className="auth-wait">
                  <p className="muted center">Finish signing in in your web browser, then come back here.</p>
                  {authUrl && (
                    <div className="auth-link">
                      <span className="muted small">Browser didn't open? Copy this link into it:</span>
                      <div className="auth-link-row">
                        <code>{authUrl}</code>
                        <button className="btn soft small" onClick={() => navigator.clipboard?.writeText(authUrl)}>Copy</button>
                        <button className="btn soft small" onClick={() => api.openUrl(authUrl)}>Open</button>
                      </div>
                    </div>
                  )}
                  <button className="link-btn" onClick={() => api.googleCancel()}>Cancel sign-in</button>
                </div>
              ) : (
                <p className="muted center">Your browser opens Google's sign-in page. NodaDock never sees your Google password.</p>
              )}
            </div>
          )}

          {p.type === "gdrive" && testing && <div className="note"><Spinner />Checking access to Google Drive…</div>}
          {p.type === "gdrive" && tested && !testing && (
            <div className="note ok"><Icon.Check size={16} />Google Drive is reachable{tested.total ? `. ${formatBytes(tested.free)} free of ${formatBytes(tested.total)}.` : "."}</div>
          )}
          {(token || editing) && (
            <div className="row2">
              <Field label="Drive">
                <select value={p.sharedDriveId} onChange={(e) => {
                  const sd = shared.find((s) => s.id === e.target.value);
                  setProv({ sharedDriveId: e.target.value, sharedDriveName: sd?.name ?? "" });
                }}>
                  <option value="">My Drive</option>
                  {p.sharedDriveId && !shared.some((s) => s.id === p.sharedDriveId) && <option value={p.sharedDriveId}>{p.sharedDriveName || "Shared drive"}</option>}
                  {shared.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Folder" hint="Leave empty for everything">
                <input value={d.remotePath} onChange={(e) => set({ remotePath: e.target.value })} placeholder="/" spellCheck={false} />
              </Field>
            </div>
          )}

          <button className="link-btn" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? "Hide" : "Show"} advanced options
          </button>
          {showAdvanced && (
            <div className="advanced">
              <p className="muted small">
                Optional. Google limits how fast the shared default app ID can work. For heavy use, create your own
                OAuth client in Google Cloud Console and enter it here, then sign in again.
              </p>
              <div className="row2">
                <Field label="Client ID">
                  <input value={p.clientId} onChange={(e) => setProv({ clientId: e.target.value })} spellCheck={false} />
                </Field>
                <Field label="Client secret">
                  <PasswordInput value={clientSecret ?? ""} onChange={setClientSecret} />
                </Field>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="form">
          <div className="row2">
            <Field label="Name">
              <input value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
            </Field>
            {os === "windows" ? (
              <Field label="Drive letter">
                <select value={d.mountPoint} onChange={(e) => set({ mountPoint: e.target.value })}>
                  <option value="">Automatic</option>
                  {d.mountPoint && !info?.freeLetters.includes(d.mountPoint) && <option value={d.mountPoint}>{d.mountPoint}</option>}
                  {info?.freeLetters.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Mount location" hint={`Leave empty to use ${info?.mountRoot ?? "~/NodaDock"}/${d.name || "Name"}`}>
                <input value={d.mountPoint} onChange={(e) => set({ mountPoint: e.target.value })} placeholder="Automatic" spellCheck={false} />
              </Field>
            )}
          </div>

          <div className="field">
            <span className="field-label">Color</span>
            <div className="swatches">
              {COLORS.map((c) => (
                <button key={c} type="button" className={`swatch ${d.color === c ? "active" : ""}`} style={{ background: c }}
                  onClick={() => set({ color: c })} aria-label={`Color ${c}`} />
              ))}
            </div>
          </div>

          <div className="option-list">
            <label className="option">
              <div>
                <b>Connect automatically</b>
                <span className="muted">Mount this drive whenever NodaDock starts, including after a restart.</span>
              </div>
              <Switch checked={d.autoMount} onChange={(v) => set({ autoMount: v })} label="Connect automatically" />
            </label>

            {p.type === "webdav" && (
              <div className="option column">
                <b>Password</b>
                <div className="radio-cards">
                  <button type="button" className={`radio-card ${d.rememberPassword ? "active" : ""}`} onClick={() => set({ rememberPassword: true })}>
                    <Icon.Shield size={18} />
                    <span><b>Remember it</b><span className="muted">Kept safely in {credentialStore(os)}. No typing after a restart.</span></span>
                  </button>
                  <button type="button" className={`radio-card ${!d.rememberPassword ? "active" : ""}`} onClick={() => set({ rememberPassword: false })}>
                    <Icon.Lock size={18} />
                    <span><b>Ask every time</b><span className="muted">Never saved. NodaDock asks for it each time your computer starts.</span></span>
                  </button>
                </div>
              </div>
            )}

            <div className="option column">
              <b>Caching</b>
              <Segmented value={d.cacheMode} onChange={(v) => set({ cacheMode: v })}
                options={CACHE.map((c) => ({ value: c.value, label: c.label }))} />
              <span className="muted">{CACHE.find((c) => c.value === d.cacheMode)?.hint}</span>
            </div>

            <label className="option">
              <div>
                <b>Read-only</b>
                <span className="muted">Browse and open files without being able to change them.</span>
              </div>
              <Switch checked={d.readOnly} onChange={(v) => set({ readOnly: v })} label="Read-only" />
            </label>

            {os === "windows" && (
              <label className="option">
                <div>
                  <b>Show as a network drive</b>
                  <span className="muted">Appears under Network locations in File Explorer instead of as a local disk.</span>
                </div>
                <Switch checked={d.networkMode} onChange={(v) => set({ networkMode: v })} label="Network drive" />
              </label>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="note bad">
          <Icon.Alert size={16} />
          <span>{error}</span>
          {step === 1 && p.type === "webdav" && !testing && (
            <button className="link-btn" onClick={() => { setTested({}); setError(null); setStep(2); if (!d.name) set({ name: capitalize(hostName(p.url)) || "My WebDAV" }); }}>
              Continue anyway
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

interface UrlParts { scheme: string; host: string; port: string; path: string }

function splitUrl(url: string): UrlParts {
  try {
    const u = new URL(url);
    return { scheme: u.protocol.replace(":", ""), host: u.hostname, port: u.port, path: u.pathname === "/" ? "" : decodeURI(u.pathname) };
  } catch {
    return { scheme: "https", host: "", port: "", path: "" };
  }
}

function joinUrl(f: UrlParts): string {
  const host = f.host.trim();
  if (!host) return "";
  let path = f.path.trim();
  if (path && !path.startsWith("/")) path = "/" + path;
  return `${f.scheme}://${host}${f.port ? ":" + f.port : ""}${path}`;
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
