import { useEffect, useState } from "react";
import styles from "./CameraFeed.module.css";

export function CameraFeed({
  src,
  live = false,
  caption,
  aspect = "wide",
}: {
  src?: string;
  live?: boolean;
  caption?: string;
  aspect?: "wide" | "square";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const demo = src?.includes("camera-demo.png");
  const returned = src?.includes("camera-returned.png");
  return (
    <figure className={styles.figure}>
      <div
        className={`${styles.viewport} ${aspect === "square" ? styles.square : ""}`}
      >
        {src && !failed ? (
          <img
            src={src}
            alt={
              live ? "Current front entrance camera" : "Recorded camera image"
            }
            onError={() => setFailed(true)}
            className={
              demo ? styles.demo : returned ? styles.returned : styles.live
            }
          />
        ) : (
          <div className={styles.empty}>
            <span aria-hidden>◌</span>
            <strong>Camera unavailable</strong>
            <p>Start the door camera to see a live view.</p>
          </div>
        )}
        {live && src && !failed && (
          <span className={styles.liveBadge}>● Live</span>
        )}
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
