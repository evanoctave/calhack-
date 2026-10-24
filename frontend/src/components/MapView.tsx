import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Place } from "../data/types";
import styles from "./MapView.module.css";

const emptyPlaces: Place[] = [];

export default function MapView({
  home,
  hazards = emptyPlaces,
  callFirst = emptyPlaces,
  familiar = emptyPlaces,
  preview = false,
}: {
  home: { lat: number; lng: number; radius_mi?: number };
  hazards?: Place[];
  callFirst?: Place[];
  familiar?: Place[];
  preview?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  useEffect(() => {
    if (
      preview ||
      !ref.current ||
      !Number.isFinite(home.lat) ||
      !Number.isFinite(home.lng)
    )
      return;
    const map = L.map(ref.current, { scrollWheelZoom: false }).setView(
      [home.lat, home.lng],
      14,
    );
    const tiles = L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    ).addTo(map);
    tiles.on("tileerror", () => setTilesFailed(true));
    const radius = L.circle([home.lat, home.lng], {
      radius: (home.radius_mi || 1.5) * 1609.34,
      color: "#245dd6",
      weight: 1.5,
      fillOpacity: 0.06,
    }).addTo(map);
    const homeLabel = document.createElement("span");
    homeLabel.textContent = "Home";
    L.circleMarker([home.lat, home.lng], {
      color: "#182335",
      radius: 5,
      fillOpacity: 1,
    })
      .addTo(map)
      .bindPopup(homeLabel);
    for (const [places, color] of [
      [hazards, "#be263b"],
      [callFirst, "#23764a"],
      [familiar, "#245dd6"],
    ] as const) {
      for (const place of places) {
        if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng))
          continue;
        const label = document.createElement("span");
        label.textContent = place.name;
        L.circleMarker([place.lat, place.lng], {
          color,
          fillColor: color,
          radius: 7,
          fillOpacity: 0.85,
          weight: 2,
        })
          .addTo(map)
          .bindPopup(label);
      }
    }
    map.fitBounds(radius.getBounds(), { padding: [12, 12] });
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      map.remove();
    };
  }, [
    home.lat,
    home.lng,
    home.radius_mi,
    hazards,
    callFirst,
    familiar,
    preview,
  ]);
  return (
    <div className="stack gap-sm">
      {preview ? (
        <img
          className={styles.preview}
          src={`${import.meta.env.BASE_URL}assets/map-preview.png`}
          alt="Recorded sample map of the Marina search area"
        />
      ) : (
        <div
          className={styles.map}
          ref={ref}
          aria-label="Nearby places and hazards map"
        />
      )}
      <div className={styles.legend}>
        <span>
          <i className={styles.hazard} /> Hazards
        </span>
        <span>
          <i className={styles.call} /> Call first
        </span>
        <span>
          <i className={styles.familiar} /> Familiar
        </span>
      </div>
      <p className="caption muted">
        {preview ? "Sample search area. " : "Search reference. "}This is not
        Dad’s live location.
      </p>
      {tilesFailed && (
        <p role="status" className="caption muted">
          Map tiles could not load. The places below are still available.
        </p>
      )}
    </div>
  );
}
