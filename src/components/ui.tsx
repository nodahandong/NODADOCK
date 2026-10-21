import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, footer, width = 560 }: {
  title: ReactNode; subtitle?: ReactNode; onClose?: () => void; children: ReactNode; footer?: ReactNode; width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.X /></button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function PasswordInput({ value, onChange, placeholder, autoFocus, onEnter }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; onEnter?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input type={show ? "text" : "password"} value={value} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter?.()} spellCheck={false} />
      <button type="button" className="input-icon" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
        {show ? <Icon.EyeOff size={16} /> : <Icon.Eye size={16} />}
      </button>
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Menu({ items }: { items: { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="More actions"><Icon.More /></button>
      {open && (
        <div className="menu-pop">
          {items.map((it) => (
            <button key={it.label} className={it.danger ? "danger" : ""} onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ConfirmSpec {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  cancel?: string;
  onConfirm: () => void;
}

export function Confirm({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  return (
    <Modal title={spec.title} onClose={onClose} width={440}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>{spec.cancel ?? "Cancel"}</button>
          <button className={`btn ${spec.danger ? "danger" : "primary"}`} autoFocus
            onClick={() => { onClose(); spec.onConfirm(); }}>{spec.confirm}</button>
        </>
      }>
      <div className="confirm-body">{spec.body}</div>
    </Modal>
  );
}
