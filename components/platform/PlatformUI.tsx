"use client";

import { ReactNode, useEffect, useRef } from "react";
import { ArrowUpRight, Check, CircleHelp, Loader2, X } from "lucide-react";
import { Company, GRADE_LABELS, Grade, safeUrl } from "./types";

export function GradeBadge({ grade = "unknown" }: { grade?: Grade }) {
  return <span className={`ts-grade ts-grade-${grade}`}><span>{grade === "unknown" ? "?" : grade}</span>{GRADE_LABELS[grade]?.split(" · ")[1] || "待补证"}</span>;
}

export function Button({ children, variant = "secondary", busy, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" | "danger"; busy?: boolean }) {
  return <button {...props} disabled={props.disabled || busy} className={`ts-button ts-button-${variant} ${className}`}>
    {busy && <Loader2 size={16} className="ts-spin" aria-hidden="true" />}{children}
  </button>;
}

export function ExternalLink({ url, children, className = "" }: { url?: string; children: ReactNode; className?: string }) {
  const href = safeUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className={`ts-external ${className}`}>{children}<ArrowUpRight size={14} aria-hidden="true" /></a> : <span className="ts-muted">{children}</span>;
}

export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const elements = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]');
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = scroll; previous?.focus(); };
  }, []);
  return <div className="ts-modal-layer" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`ts-modal ${wide ? "ts-modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="ts-modal-title" ref={ref} tabIndex={-1}>
      <header className="ts-modal-header"><div><h2 id="ts-modal-title">{title}</h2>{description && <p>{description}</p>}</div><button className="ts-icon-button" aria-label="关闭窗口" onClick={onClose}><X size={20} /></button></header>
      {children}
    </div>
  </div>;
}

export function EmptyState({ icon, title, description, children, compact }: { icon?: ReactNode; title: string; description: string; children?: ReactNode; compact?: boolean }) {
  return <div className={`ts-empty ${compact ? "ts-empty-compact" : ""}`}>
    <div className="ts-empty-icon">{icon || <CircleHelp size={27} />}</div><h3>{title}</h3><p>{description}</p>{children && <div className="ts-empty-actions">{children}</div>}
  </div>;
}

export function CompanyAvatar({ company, small }: { company: Company; small?: boolean }) {
  return <span className={`ts-company-avatar ${small ? "ts-company-avatar-small" : ""}`} aria-hidden="true">{(company.name || "?").replace(/https?:\/\//, "").slice(0, 2).toUpperCase()}</span>;
}

export function SavedNotice({ children }: { children: ReactNode }) {
  return <div className="ts-saved-notice" role="status"><Check size={16} />{children}</div>;
}
