import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNearbySearch } from "../state/useNearbySearch";
import { Badge, Button, Card } from "./ui";
import styles from "./NearbySearchProgress.module.css";

export function NearbySearchProgress({
  phase,
  startedAt,
}: {
  phase: "locating" | "searching";
  startedAt: number | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - (startedAt || now)) / 1000));
  const steps = [
    "Check address & map",
    "Find nearby businesses",
    "Search ready",
  ];
  const current = phase === "locating" ? 0 : 1;
  return (
    <Card>
      <div className={styles.heading}>
        <h2>Preparing your search area</h2>
        {startedAt && (
          <span className={styles.elapsed}>
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}{" "}
            elapsed
          </span>
        )}
      </div>
      <ol className={styles.steps} aria-label="Nearby search progress">
        {steps.map((label, index) => (
          <li key={label} aria-current={index === current ? "step" : undefined}>
            <span className={styles.marker} aria-hidden>
              {index < current ? "✓" : index + 1}
            </span>
            <span>{label}</span>
            {index === current && <span className="spinner" aria-hidden />}
          </li>
        ))}
      </ol>
      <p className="caption muted" role="status">
        {phase === "locating"
          ? "Your address is being checked. It has not been confirmed saved yet."
          : "Address saved. Nearby businesses and contact details are still being collected."}
      </p>
      <p className={styles.note}>
        You can continue setup. Keep this app open; check Home for the result.
      </p>
    </Card>
  );
}

export function NearbySearchSummary() {
  const search = useNearbySearch();
  const navigate = useNavigate();
  if (!search.busy && !search.saved && search.phase !== "error") return null;
  const failed = search.phase === "error";
  return (
    <Card>
      <div className={styles.heading}>
        <h2>Nearby places</h2>
        <Badge tone={failed ? "warning" : search.busy ? "info" : "success"}>
          {failed ? "Needs attention" : search.busy ? "Preparing" : "Ready"}
        </Badge>
      </div>
      <p className={styles.note} role="status">
        {failed
          ? "Your search needs attention. Open it to check the result or try again."
          : search.phase === "locating"
            ? "Checking your home address and nearby map. Setup can continue."
            : search.phase === "searching"
              ? "Address saved. Finding nearby businesses and contact details."
              : search.completedAt
                ? "Your nearby search is complete. Open the map to review the places."
                : "Saved places are ready to review. Refresh only when you need a new search."}
      </p>
      <Button variant="secondary" onClick={() => navigate("/setup/nearby")}>
        {failed
          ? "Review search"
          : search.busy
            ? "View search progress"
            : "View nearby places"}
      </Button>
    </Card>
  );
}
