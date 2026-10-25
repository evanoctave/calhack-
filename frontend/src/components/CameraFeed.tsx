import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./CameraFeed.module.css";

type CameraAspect = "wide" | "square" | "monitor" | "native";

// The recorded fixtures contain a dashboard around the camera. These view boxes
// show only the photographed camera area, without scaling or cropping the person.
const recordedCrops = {
  demo: { viewBox: "80 155 616 472", width: 790, height: 828 },
  returned: { viewBox: "840 326 615 465", width: 2594, height: 1844 },
};

function CameraPicture({
  src,
  live,
  uncropped,
  onError,
}: {
  src: string;
  live: boolean;
  uncropped: boolean;
  onError: () => void;
}) {
  const cropId = useId();
  const demo = src.includes("camera-demo.png");
  const returned = src.includes("camera-returned.png");
  const crop = demo
    ? recordedCrops.demo
    : returned
      ? recordedCrops.returned
      : null;
  const label = live
    ? "Current front entrance camera"
    : "Recorded camera image";
  if (uncropped && crop) {
    const [x, y, width, height] = crop.viewBox.split(" ").map(Number);
    return (
      <svg
        viewBox={crop.viewBox}
        className={styles.cameraPicture}
        role="img"
        aria-label={label}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <clipPath id={cropId}>
            <rect x={x} y={y} width={width} height={height} />
          </clipPath>
        </defs>
        <image
          href={src}
          width={crop.width}
          height={crop.height}
          clipPath={`url(#${cropId})`}
          onError={onError}
        />
      </svg>
    );
  }
  return (
    <img
      src={src}
      alt={label}
      onError={onError}
      className={
        uncropped
          ? styles.cameraPicture
          : demo
            ? styles.demo
            : returned
              ? styles.returned
              : styles.live
      }
    />
  );
}

function CameraUnavailable() {
  return (
    <div className={styles.empty}>
      <span aria-hidden>◌</span>
      <strong>Camera unavailable</strong>
      <p>Start the door camera to see a live view.</p>
    </div>
  );
}

export function CameraFeed({
  src,
  live = false,
  caption,
  aspect = "wide",
  expandable = false,
}: {
  src?: string;
  live?: boolean;
  caption?: string;
  aspect?: CameraAspect;
  expandable?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const available = Boolean(src && failedSrc !== src);
  const uncropped = aspect === "monitor" || aspect === "native";

  useEffect(() => {
    if (!expanded) return;
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [expanded]);

  const picture = (full: boolean) =>
    available && src ? (
      <CameraPicture
        src={src}
        live={live}
        uncropped={full || uncropped}
        onError={() => setFailedSrc(src)}
      />
    ) : (
      <CameraUnavailable />
    );

  return (
    <>
      <figure className={styles.figure}>
        <div
          className={`${styles.viewport} ${styles[aspect]} ${available ? "" : styles.unavailable}`}
        >
          {picture(false)}
          {live && available && (
            <span className={styles.liveBadge}>● Live</span>
          )}
          {expandable && (
            <button
              type="button"
              ref={triggerRef}
              className={styles.expand}
              aria-label="View camera full screen"
              aria-haspopup="dialog"
              aria-disabled={!available}
              onClick={() => {
                if (available) setExpanded(true);
              }}
            >
              {available && (
                <span className={styles.expandLabel}>⛶ Expand</span>
              )}
            </button>
          )}
        </div>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      {expanded &&
        createPortal(
          <dialog
            ref={dialogRef}
            className={styles.fullscreen}
            aria-labelledby={titleId}
            onCancel={(event) => {
              event.preventDefault();
              setExpanded(false);
            }}
          >
            <header className={styles.viewerHeader}>
              <div>
                <h2 id={titleId}>Front entrance camera</h2>
                <p>
                  {live && available
                    ? "Live"
                    : available
                      ? "Camera image"
                      : "Camera unavailable"}
                </p>
              </div>
              <button
                type="button"
                className={styles.close}
                aria-label="Close full-screen camera"
                onClick={() => setExpanded(false)}
                autoFocus
              >
                <span aria-hidden>×</span> Close
              </button>
            </header>
            <div className={styles.fullscreenImage}>{picture(true)}</div>
            {caption && <p className={styles.viewerCaption}>{caption}</p>}
          </dialog>,
          document.body,
        )}
    </>
  );
}
