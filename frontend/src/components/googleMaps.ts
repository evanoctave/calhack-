/// <reference types="google.maps" />
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

export type GoogleMapLibraries = {
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
  core: google.maps.CoreLibrary;
};

export function googleMapsKey(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "").trim();
}
export function googleMapsMapId(): string {
  return (
    (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || "").trim() || "DEMO_MAP_ID"
  );
}

let configured = false;
let pending: Promise<GoogleMapLibraries> | undefined;
export function loadGoogleMaps(): Promise<GoogleMapLibraries> {
  const key = googleMapsKey();
  if (!key) return Promise.reject(new Error("Google Maps is not configured"));
  if (!configured) {
    setOptions({ key, v: "weekly", language: "en", region: "US" });
    configured = true;
  }
  if (!pending) {
    pending = Promise.all([
      importLibrary("maps"),
      importLibrary("marker"),
      importLibrary("core"),
    ])
      .then(([maps, marker, core]) => ({ maps, marker, core }))
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
  }
  return pending;
}

// Auth failures may arrive after script loading; remember them across routes.
const authListeners = new Set<() => void>();
let authFailed = false;
let authInstalled = false;
export function onGoogleMapsAuthFailure(listener: () => void): () => void {
  if (!authInstalled) {
    const host = window as Window & { gm_authFailure?: () => void };
    const previous = host.gm_authFailure;
    host.gm_authFailure = () => {
      authFailed = true;
      authListeners.forEach((notify) => notify());
      previous?.();
    };
    authInstalled = true;
  }
  authListeners.add(listener);
  if (authFailed) listener();
  return () => {
    authListeners.delete(listener);
  };
}
export function validMapPosition(position: {
  lat: number;
  lng: number;
}): boolean {
  return (
    Number.isFinite(position.lat) &&
    Math.abs(position.lat) <= 90 &&
    Number.isFinite(position.lng) &&
    Math.abs(position.lng) <= 180
  );
}
export function googleMapsDirections(position: {
  lat: number;
  lng: number;
}): string {
  const url = new URL("https://www.google.com/maps/dir/");
  url.search = new URLSearchParams({
    api: "1",
    destination: position.lat + "," + position.lng,
    travelmode: "walking",
  }).toString();
  return url.toString();
}
