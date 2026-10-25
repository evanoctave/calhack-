import { useEffect, useRef, useState } from "react";
import type { Place } from "../data/types";
import {
  googleMapsDirections,
  googleMapsKey,
  googleMapsMapId,
  loadGoogleMaps,
  onGoogleMapsAuthFailure,
  validMapPosition,
  type GoogleMapLibraries,
} from "./googleMaps";
import styles from "./MapView.module.css";

const emptyPlaces: Place[] = [];
type MapSession = { map: google.maps.Map; libraries: GoogleMapLibraries };

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
  const focusArea = useRef<(() => void) | null>(null);
  const lastArea = useRef("");
  const [session, setSession] = useState<MapSession | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const configured = !!googleMapsKey();
  const validHome = validMapPosition(home);
  const radiusMi =
    Number.isFinite(home.radius_mi) && home.radius_mi! > 0
      ? home.radius_mi!
      : 1.5;

  useEffect(() => {
    if (!configured || !validHome || !ref.current) return;
    const container = ref.current;
    let active = true;
    let failed = false;
    let created: MapSession | null = null;
    setStatus("loading");
    setSession(null);
    lastArea.current = "";
    const fail = () => {
      failed = true;
      if (active) setStatus("error");
    };
    const unsubscribe = onGoogleMapsAuthFailure(fail);
    const timeout = window.setTimeout(fail, 15_000);
    void loadGoogleMaps()
      .then((libraries) => {
        if (!active || failed) return;
        const map = new libraries.maps.Map(container, {
          center: { lat: home.lat, lng: home.lng },
          zoom: 14,
          mapId: googleMapsMapId(),
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          gestureHandling: "cooperative",
          clickableIcons: false,
        });
        created = { map, libraries };
        window.clearTimeout(timeout);
        setSession(created);
        setStatus("ready");
      })
      .catch(fail);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      unsubscribe();
      if (created)
        created.libraries.core.event.clearInstanceListeners(created.map);
      container.replaceChildren();
      focusArea.current = null;
    };
  }, [configured, validHome, home.lat, home.lng, attempt]);

  // Refresh pins without recreating the map or resetting the user's pan/zoom.
  useEffect(() => {
    if (!session || !validHome) return;
    const {
      map,
      libraries: { maps, marker, core },
    } = session;
    const listeners: google.maps.MapsEventListener[] = [];
    const pins: google.maps.marker.AdvancedMarkerElement[] = [];
    const info = new maps.InfoWindow();
    const circle = new maps.Circle({
      map,
      center: { lat: home.lat, lng: home.lng },
      radius: radiusMi * 1609.344,
      strokeColor: "#245dd6",
      strokeWeight: 1.5,
      strokeOpacity: 0.7,
      fillColor: "#245dd6",
      fillOpacity: 0.06,
      clickable: false,
    });
    const fit = () => {
      const bounds = circle.getBounds();
      if (bounds) map.fitBounds(bounds, 24);
    };
    focusArea.current = fit;
    const areaKey = [home.lat, home.lng, radiusMi].join(",");
    if (lastArea.current !== areaKey) {
      fit();
      lastArea.current = areaKey;
    }
    const addPin = (
      place: Place,
      category: string,
      color: string,
      glyph?: string,
    ) => {
      if (!validMapPosition(place)) return;
      const pin = new marker.PinElement({
        background: color,
        borderColor: "#ffffff",
        glyphColor: "#ffffff",
        scale: category === "Home" ? 1 : 0.85,
        ...(glyph ? { glyphText: glyph } : {}),
      });
      const point = new marker.AdvancedMarkerElement({
        map,
        position: { lat: place.lat, lng: place.lng },
        title: category + " · " + place.name,
        content: pin.element,
        zIndex: category === "Home" ? 10 : 1,
      });
      pins.push(point);
      listeners.push(
        point.addListener("click", () => {
          const content = document.createElement("div");
          content.className = styles.popup;
          const title = document.createElement("strong");
          title.textContent = place.name;
          const detail = document.createElement("p");
          detail.textContent = [
            category,
            place.distance_mi != null
              ? place.distance_mi + " mi from home"
              : "",
            preview ? "Sample place" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const directions = document.createElement("a");
          directions.href = googleMapsDirections(place);
          directions.textContent = "Directions in Google Maps";
          directions.target = "_blank";
          directions.rel = "noopener noreferrer";
          content.append(title, detail, directions);
          info.setContent(content);
          info.open({ map, anchor: point, shouldFocus: false });
        }),
      );
    };
    addPin(
      { name: "Home", lat: home.lat, lng: home.lng },
      "Home",
      "#182335",
      "H",
    );
    hazards.forEach((place) => addPin(place, "Hazard", "#be263b"));
    callFirst.forEach((place) => addPin(place, "Call first", "#23764a"));
    familiar.forEach((place) => addPin(place, "Familiar place", "#245dd6"));
    return () => {
      listeners.forEach((listener) => listener.remove());
      pins.forEach((pin) => {
        pin.map = null;
      });
      circle.setMap(null);
      info.close();
      core.event.clearInstanceListeners(info);
      focusArea.current = null;
    };
  }, [
    session,
    validHome,
    home.lat,
    home.lng,
    radiusMi,
    hazards,
    callFirst,
    familiar,
    preview,
  ]);

  const ready = configured && validHome && status === "ready";
  return (
    <div className="stack gap-sm">
      <div className={styles.frame}>
        <div
          className={styles.map}
          ref={ref}
          role="region"
          aria-label="Google Maps search area"
          aria-hidden={!ready}
        />
        {!ready && (
          <div className={styles.placeholder} role="status">
            <strong>
              {!validHome
                ? "Home location is unavailable"
                : !configured
                  ? "Google Maps is not connected yet"
                  : status === "error"
                    ? "Google Maps couldn’t load"
                    : "Loading Google Maps…"}
            </strong>
            <p className="caption muted">
              {configured && validHome && status === "loading"
                ? "Opening the search area."
                : "You can still use the place details below."}
            </p>
            {configured && validHome && status === "error" && (
              <button
                type="button"
                className={styles.mapButton}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      <div className={styles.legend} aria-label="Map legend">
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
      <div className={styles.mapFooter}>
        <p className="caption muted">{radiusMi} mi around home</p>
        {ready && (
          <button
            type="button"
            className={styles.mapButton}
            onClick={() => focusArea.current?.()}
          >
            Show search area
          </button>
        )}
      </div>
      <p className="caption muted">
        {preview ? "Sample places. " : "Search reference. "}This is not Dad’s
        live location.
      </p>
    </div>
  );
}
