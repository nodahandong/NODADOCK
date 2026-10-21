import type { Drive } from "./types";

export interface ServiceField {
  key: string;
  label: string;
  type?: "text" | "select" | "check" | "ftp-tls";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  choices?: { value: string; label: string }[];
  default?: string;
  wide?: boolean;
}

export interface Service {
  id: string;
  /** webdav and gdrive have their own forms; oauth = browser sign-in; form = fields below */
  kind: "webdav" | "gdrive" | "oauth" | "form";
  backend?: string;
  label: string;
  desc: string;
  group: "cloud" | "server" | "storage";
  color: string;
  fields?: ServiceField[];
  secretLabel?: string;
  secretRequired?: boolean;
  pathLabel?: string;
  pathHint?: string;
  note?: string;
}

export const GROUPS: { id: Service["group"]; label: string }[] = [
  { id: "cloud", label: "Cloud drives" },
  { id: "server", label: "Your own server or NAS" },
  { id: "storage", label: "Object storage" },
];

export const SERVICES: Service[] = [
  { id: "gdrive", kind: "gdrive", label: "Google Drive", desc: "My Drive or a shared drive", group: "cloud", color: "#12b886" },
  { id: "onedrive", kind: "oauth", backend: "onedrive", label: "OneDrive", desc: "Personal, Business or SharePoint", group: "cloud", color: "#1c7ed6" },
  { id: "dropbox", kind: "oauth", backend: "dropbox", label: "Dropbox", desc: "Personal or Business", group: "cloud", color: "#3d5afe" },
  { id: "box", kind: "oauth", backend: "box", label: "Box", desc: "Box.com accounts", group: "cloud", color: "#0b6bcb" },
  {
    id: "mega", kind: "form", backend: "mega", label: "MEGA", desc: "Email and password", group: "cloud", color: "#e03131",
    fields: [{ key: "user", label: "Email", required: true, placeholder: "you@example.com", wide: true }],
    secretLabel: "Password", secretRequired: true,
    note: "Accounts with two-factor sign-in turned on can't be connected yet.",
  },
  { id: "webdav", kind: "webdav", label: "WebDAV", desc: "Nextcloud, Synology, QNAP, ownCloud…", group: "server", color: "#4f6bff" },
  {
    id: "sftp", kind: "form", backend: "sftp", label: "SFTP", desc: "Any computer or NAS with SSH", group: "server", color: "#495057",
    fields: [
      { key: "host", label: "Server address", required: true, placeholder: "server.example.com or 192.168.1.20" },
      { key: "port", label: "Port", placeholder: "22" },
      { key: "user", label: "Username", required: true },
      { key: "key_file", label: "Private key file (optional)", placeholder: "C:\\Users\\you\\.ssh\\id_ed25519", hint: "Only if you sign in with an SSH key instead of a password.", wide: true },
    ],
    secretLabel: "Password", secretRequired: false,
    pathHint: "For example /home/you/files. Leave empty for your home folder.",
  },
  {
    id: "ftp", kind: "form", backend: "ftp", label: "FTP / FTPS", desc: "Classic file servers and web hosting", group: "server", color: "#f08c00",
    fields: [
      { key: "host", label: "Server address", required: true, placeholder: "ftp.example.com" },
      { key: "port", label: "Port", placeholder: "21" },
      { key: "user", label: "Username", required: true },
      { key: "_tls", label: "Encryption", type: "ftp-tls" },
      { key: "no_check_certificate", label: "Allow self-signed certificate", type: "check", wide: true },
    ],
    secretLabel: "Password", secretRequired: true,
  },
  {
    id: "s3", kind: "form", backend: "s3", label: "S3-compatible", desc: "Amazon S3, Wasabi, Cloudflare R2, MinIO…", group: "storage", color: "#e8590c",
    fields: [
      {
        key: "provider", label: "Provider", type: "select", default: "AWS",
        choices: [
          { value: "AWS", label: "Amazon S3" },
          { value: "Wasabi", label: "Wasabi" },
          { value: "Cloudflare", label: "Cloudflare R2" },
          { value: "Minio", label: "MinIO" },
          { value: "DigitalOcean", label: "DigitalOcean Spaces" },
          { value: "IDrive", label: "IDrive e2" },
          { value: "Other", label: "Other S3-compatible" },
        ],
      },
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "access_key_id", label: "Access key ID", required: true, wide: true },
      { key: "endpoint", label: "Endpoint", placeholder: "https://…", hint: "Not needed for Amazon S3. Required for R2, MinIO and most others.", wide: true },
    ],
    secretLabel: "Secret access key", secretRequired: true,
    pathLabel: "Bucket and folder", pathHint: "For example my-bucket or my-bucket/photos. Leave empty to see all buckets.",
  },
  {
    id: "b2", kind: "form", backend: "b2", label: "Backblaze B2", desc: "Low-cost cloud storage", group: "storage", color: "#c92a2a",
    fields: [{ key: "account", label: "Application key ID", required: true, wide: true }],
    secretLabel: "Application key", secretRequired: true,
    pathLabel: "Bucket and folder", pathHint: "For example my-bucket. Leave empty to see all buckets.",
  },
];

export function serviceOf(d: Drive): Service {
  const p = d.provider;
  const id = p.type === "cloud" ? p.backend : p.type;
  return SERVICES.find((s) => s.id === id) ?? SERVICES[0];
}

export function usesPassword(d: Drive): boolean {
  const s = serviceOf(d);
  return s.kind === "webdav" || s.kind === "form";
}
