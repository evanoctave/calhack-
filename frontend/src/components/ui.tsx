import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import styles from "./ui.module.css";

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet";
}) {
  return (
    <button
      type={type}
      className={`${styles.button} ${styles[variant]} ${className}`}
      {...props}
    />
  );
}
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${styles.card} ${className}`}>{children}</section>
  );
}
export function PageHeader({
  title,
  description,
  back,
  eyebrow,
  action,
}: {
  title: string;
  description?: string;
  back?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      {(back || action) && (
        <div className="inline spread">
          {back ? (
            <Link className={styles.back} to={back}>
              <span aria-hidden>‹</span> Back
            </Link>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p className="muted">{description}</p>}
    </header>
  );
}
export type Tone = "info" | "warning" | "success" | "danger" | "neutral";
export function Notice({
  tone = "info",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <div
      className={`${styles.notice} ${styles[tone]}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Badge({
  tone = "info",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
export function Field({
  label,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const uid = useId();
  return (
    <label className={styles.field} htmlFor={id || uid}>
      <span>{label}</span>
      <input id={id || uid} {...props} />
    </label>
  );
}
export function Row({
  title,
  detail,
  trailing,
  onClick,
}: {
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className={styles.rowText}>
        <strong>{title}</strong>
        {detail && <span className="caption muted">{detail}</span>}
      </div>
      {trailing || (onClick ? <span aria-hidden>›</span> : null)}
    </>
  );
  return onClick ? (
    <button type="button" className={styles.row} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={styles.row}>{content}</div>
  );
}
export function Progress({ step, total }: { step: number; total: number }) {
  return (
    <div
      className={styles.progress}
      aria-label={`Set up Nightfall, step ${step} of ${total}`}
    >
      <div className="inline spread">
        <span className="eyebrow">Set up Nightfall</span>
        <span className="caption accent">
          {step} of {total}
        </span>
      </div>
      <div className={styles.progressBars}>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={i < step ? styles.filled : ""} />
        ))}
      </div>
    </div>
  );
}
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      el?.close();
      document.body.style.overflow = previous;
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={styles.sheet}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheetBody}>
        <div className={styles.grabber} />
        <div className="inline spread">
          <h2 id={id}>{title}</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
