import { useEffect, useState } from "react";
import { api, errText, on } from "../api";
import type { Drive, SharedDrive, SystemInfo, Usage } from "../types";
import { GROUPS, SERVICES, serviceOf, usesPassword, type Service, type ServiceField } from "../services";
import { COLORS, credentialStore, formatBytes, hostName } from "../util";
import { Icon, ProviderIcon } from "./Icons";
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

function newDrive(service: Service, index: number): Drive {
  let provider: Drive["provider"];
  if (service.kind === "webdav") provider = { type: "webdav", url: "", vendor: "other", username: "" };
  else if (service.kind === "gdrive") provider = { type: "gdrive", account: "", sharedDriveId: "", sharedDriveName: "", clientId: "" };
  else {
    const options: Record<string, string> = {};
    for (const f of service.fields ?? []) if (f.default) options[f.key] = f.default;
    provider = { type: "cloud", backend: service.backend!, account: "", options };
  }
  return {
    id: "",
    name: "",
    provider,
    remotePath: "",
    mountPoint: "",
    autoMount: true,
    rememberPassword: true,
    readOnly: false,
    cacheMode: "full",
    networkMode: false,
    allowSelfSigned: false,
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
  const [d, setD] = useState<Drive>(existing ?? newDrive(SERVICES[0], driveCount));
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
  const service = serviceOf(d);
  const isOAuth = service.kind === "gdrive" || service.kind === "oauth";
  const opts = p.type === "cloud" ? p.options : {};
  const setOpt = (patch: Record<string, string>) => {
    setD((x) => (x.provider.type === "cloud" ? { ...x, provider: { ...x.provider, options: { ...x.provider.options, ...patch } } } : x));
    setTested(null);
    setError(null);
  };
  const clientId = p.type === "gdrive" ? p.clientId : opts.client_id ?? "";
  const setClientId = (v: string) => (p.type === "gdrive" ? setProv({ clientId: v }) : setOpt({ client_id: v }));
  const pick = (svc: Service) => {
    setD(newDrive(svc, driveCount));
    setPartsState(splitUrl(""));
    setPassword("");
    setToken(undefined);
    setTested(null);
    setError(null);
    setStep(1);
  };

  useEffect(() => {
    let off: (() => void) | undefined;
    on<string>("google-auth-url", setAuthUrl).then((f) => (off = f));
    return () => off?.();
  }, []);

  const secrets = () => ({ password: password || undefined, token, clientSecret });

  async function signIn() {
    if (!isOAuth) return;
    setSigningIn(true);
    setError(null);
    setAuthUrl(null);
    try {
      const r = await api.signIn(service.backend ?? "drive", clientId, clientSecret ?? "");
      setToken(r.token);
      const provider: Drive["provider"] = p.type === "cloud"
        ? { ...p, account: r.email ?? "", options: { ...p.options, ...r.options } }
        : p.type === "gdrive" ? { ...p, account: r.email ?? "" } : p;
      setD((x) => ({ ...x, provider }));
      if (p.type === "gdrive") api.googleSharedDrives(r.token).then(setShared).catch(() => {});
      // Make sure the new sign-in can actually read the drive.
      setTesting(true);
      try {
        setTested(await api.test({ ...d, provider }, { token: r.token, clientSecret }));
      } catch (e) {
        setError(`Signed in, but ${service.label} couldn't be opened: ${errText(e)}`);
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
      } else if (service.kind === "form") {
        const missing = (service.fields ?? []).find((f) => f.required && !opts[f.key]?.trim());
        if (missing) return setError(`Enter the ${missing.label.toLowerCase()}.`);
        const savedSecret = editing && d.rememberPassword;
        if (service.secretRequired && !password && !savedSecret) return setError(`Enter the ${service.secretLabel!.toLowerCase()}.`);
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
        if (!d.name) set({ name: opts.host ? capitalize(hostName("https://" + opts.host)) || service.label : service.label });
      } else {
        if (!token && !editing) return setError(`Sign in with ${service.label} to continue.`);
        if (!d.name) set({ name: (p.type === "gdrive" && p.sharedDriveName) || service.label });
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

  const title = editing ? `Edit ${existing!.name}` : ["Add a drive", `Connect to ${service.label}`, "Set up your drive"][step];
  const steps = ["Service", "Connection", "Drive"];

  const footer = (
    <>
      {step > (editing ? 1 : 0) && (
        <button className="btn ghost" onClick={() => { setStep(step - 1); setError(null); }}><Icon.Back size={16} />Back</button>
      )}
      <span className="grow" />
      {step === 1 && (
        <>
          {(p.type === "webdav" || service.kind === "form") && tested && <span className="ok-text"><Icon.Check size={16} />Connection works</span>}
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
        <div className="services">
          {GROUPS.map((g) => (
            <section key={g.id}>
              <h3 className="services-title">{g.label}</h3>
              <div className="service-grid">
                {SERVICES.filter((x) => x.group === g.id).map((svc) => (
                  <button key={svc.id} className="service" onClick={() => pick(svc)} style={{ ["--svc" as string]: svc.color }}>
                    <span className="service-icon"><ProviderIcon id={svc.id} size={22} /></span>
                    <span className="service-text"><b>{svc.label}</b><span className="muted">{svc.desc}</span></span>
                  </button>
                ))}
              </div>
            </section>
          ))}
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
          {parts.scheme === "https" && (
            <label className="check">
              <input type="checkbox" checked={d.allowSelfSigned} onChange={(e) => { set({ allowSelfSigned: e.target.checked }); setTested(null); }} />
              Allow self-signed certificate (for a NAS or office server that shows a certificate warning in the browser)
            </label>
          )}
          {tested && (tested.total ? (
            <div className="note ok"><Icon.Check size={16} />Connected. {formatBytes(tested.free)} free of {formatBytes(tested.total)}.</div>
          ) : null)}
        </div>
      )}

      {step === 1 && service.kind === "form" && (
        <div className="form">
          <div className="form-grid">
            {(service.fields ?? []).map((f) => (
              <FormField key={f.key} f={f} opts={opts} setOpt={setOpt} />
            ))}
            <div className="wide">
              <Field label={service.secretLabel ?? "Password"}
                hint={editing && d.rememberPassword ? "Leave empty to keep the saved one" : service.secretRequired ? undefined : "Optional"}>
                <PasswordInput value={password} onChange={(v) => { setPassword(v); setTested(null); }} onEnter={next}
                  placeholder={editing && d.rememberPassword ? "••••••••" : ""} />
              </Field>
            </div>
            <div className="wide">
              <Field label={service.pathLabel ?? "Folder on server"} hint={service.pathHint ?? "Leave empty for everything"}>
                <input value={d.remotePath} onChange={(e) => { set({ remotePath: e.target.value }); setTested(null); }} placeholder="/" spellCheck={false} />
              </Field>
            </div>
          </div>
          {service.note && <p className="muted small">{service.note}</p>}
          {tested && (tested.total ? (
            <div className="note ok"><Icon.Check size={16} />Connected. {formatBytes(tested.free)} free of {formatBytes(tested.total)}.</div>
          ) : null)}
        </div>
      )}

      {step === 1 && isOAuth && (
        <div className="form">
          {token || editing ? (
            <div className="signed-in">
              <span className="avatar" style={{ background: service.color }}>{((p.type !== "webdav" && p.account) || service.label)[0].toUpperCase()}</span>
              <div>
                <b>{(p.type !== "webdav" && p.account) || "Signed in"}</b>
                <span className="muted">{token ? "Signed in just now" : "Signed in"}</span>
              </div>
              <span className="grow" />
              <button className="btn ghost small" onClick={signIn} disabled={signingIn}>Switch account</button>
            </div>
          ) : (
            <div className="google-start">
              <button className="btn google" onClick={signIn} disabled={signingIn}>
                {signingIn ? <Spinner /> : <ProviderIcon id={service.id} size={18} />}
                {signingIn ? "Waiting for your browser…" : `Sign in with ${service.label}`}
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
                <p className="muted center">Your browser opens {service.label}'s sign-in page. NodaDock never sees your {service.label} password.</p>
              )}
            </div>
          )}

          {testing && <div className="note"><Spinner />Checking access to {service.label}…</div>}
          {tested && !testing && (
            <div className="note ok"><Icon.Check size={16} />{service.label} is reachable{tested.total ? `. ${formatBytes(tested.free)} free of ${formatBytes(tested.total)}.` : "."}</div>
          )}
          {(token || editing) && p.type !== "gdrive" && (
            <Field label="Folder" hint="Leave empty for everything">
              <input value={d.remotePath} onChange={(e) => set({ remotePath: e.target.value })} placeholder="/" spellCheck={false} />
            </Field>
          )}
          {(token || editing) && p.type === "gdrive" && (
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
                Optional. {service.label} limits how fast the shared default app ID can work. For heavy use, create your own
                OAuth app with {service.label} and enter its client ID and secret here, then sign in again.
              </p>
              <div className="row2">
                <Field label="Client ID">
                  <input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
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

            {usesPassword(d) && (
              <div className="option column">
                <b>{service.secretLabel ?? "Password"}</b>
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

function FormField({ f, opts, setOpt }: { f: ServiceField; opts: Record<string, string>; setOpt: (p: Record<string, string>) => void }) {
  const cls = f.wide ? "wide" : "";
  if (f.type === "check") {
    return (
      <label className={`check ${cls}`}>
        <input type="checkbox" checked={opts[f.key] === "true"} onChange={(e) => setOpt({ [f.key]: e.target.checked ? "true" : "" })} />
        {f.label}
      </label>
    );
  }
  if (f.type === "ftp-tls") {
    const v = opts.tls === "true" ? "implicit" : opts.explicit_tls === "true" ? "explicit" : "none";
    return (
      <div className={cls}>
        <Field label={f.label}>
          <select value={v} onChange={(e) => setOpt({ explicit_tls: e.target.value === "explicit" ? "true" : "", tls: e.target.value === "implicit" ? "true" : "" })}>
            <option value="none">None (plain FTP)</option>
            <option value="explicit">Explicit TLS (FTPES)</option>
            <option value="implicit">Implicit TLS (FTPS, port 990)</option>
          </select>
        </Field>
      </div>
    );
  }
  return (
    <div className={cls}>
      <Field label={f.label} hint={f.hint}>
        {f.type === "select" ? (
          <select value={opts[f.key] ?? f.default ?? ""} onChange={(e) => setOpt({ [f.key]: e.target.value })}>
            {f.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        ) : (
          <input value={opts[f.key] ?? ""} placeholder={f.placeholder} spellCheck={false} autoComplete="off"
            onChange={(e) => setOpt({ [f.key]: f.key === "port" ? e.target.value.replace(/\D/g, "").slice(0, 5) : e.target.value })} />
        )}
      </Field>
    </div>
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
