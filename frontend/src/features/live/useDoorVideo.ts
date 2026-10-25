import { useEffect, useState } from "react";
import { socketUrl } from "./media";

export function useDoorVideo(memberId: string, preview: boolean) {
  const [src, setSrc] = useState<string>();
  const [status, setStatus] = useState("Connecting to the door…");
  const [live, setLive] = useState(false);
  useEffect(() => {
    setSrc(undefined);
    setLive(false);
    if (preview) {
      setStatus("Recorded demo image · Preview");
      return;
    }
    if (!memberId) {
      setStatus("Join the care circle to view the camera.");
      return;
    }
    let active = true,
      authorized = true,
      currentUrl = "",
      lastFrame = 0,
      socket: WebSocket | undefined;
    let source: "stream" | "snapshot" | null = null,
      expiresAt = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const controller = new AbortController();
    const clearFrame = () => {
      setSrc(undefined);
      setLive(false);
      source = null;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = "";
    };
    const show = (
      blob: Blob,
      label: string,
      isLive: boolean,
      snapshotAge = 0,
    ) => {
      if (!active || !authorized) return;
      const next = URL.createObjectURL(blob),
        previous = currentUrl;
      source = isLive ? "stream" : "snapshot";
      expiresAt =
        Date.now() + (isLive ? 2500 : Math.max(0, 10000 - snapshotAge * 1000));
      currentUrl = next;
      setSrc(next);
      setLive(isLive);
      setStatus(label);
      if (previous) URL.revokeObjectURL(previous);
    };
    const connect = () => {
      if (!active) return;
      const currentSocket = new WebSocket(
        socketUrl(`/ws/video/${encodeURIComponent(memberId)}`),
      );
      socket = currentSocket;
      currentSocket.binaryType = "blob";
      currentSocket.onmessage = (event) => {
        if (
          !active ||
          !authorized ||
          socket !== currentSocket ||
          currentSocket.readyState !== WebSocket.OPEN ||
          !(event.data instanceof Blob) ||
          !event.data.size
        )
          return;
        lastFrame = Date.now();
        show(event.data, "Live · Front door camera", true);
        // New servers cap unacknowledged frames. Older servers ignore this text message.
        currentSocket.send("a");
      };
      currentSocket.onerror = () => {
        if (active && socket === currentSocket) {
          if (source === "stream") clearFrame();
          setStatus("Reconnecting to the door…");
        }
      };
      currentSocket.onclose = (event) => {
        if (!active || socket !== currentSocket) return;
        if (source === "stream") clearFrame();
        if (event.code === 4403) {
          authorized = false;
          clearFrame();
          setStatus("Your care-circle session is no longer valid.");
          return;
        }
        setStatus("Reconnecting to the door…");
        reconnect = setTimeout(connect, 2500);
      };
    };
    const poll = async () => {
      if (!authorized || polling || Date.now() - lastFrame < 2500) return;
      polling = true;
      try {
        const response = await fetch(`/cam/latest.jpg?t=${Date.now()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(
            "No live camera image. Start the door camera on the computer.",
          );
        const blob = await response.blob();
        // A slow snapshot must not overwrite a stream that recovered while the request was pending.
        if (Date.now() - lastFrame < 2500) return;
        const age = Number(response.headers.get("X-Frame-Age") || 0);
        show(
          blob,
          "Recent camera snapshot · Not a live stream",
          false,
          Number.isFinite(age) ? age : 0,
        );
      } catch (error) {
        if (
          active &&
          !controller.signal.aborted &&
          Date.now() - lastFrame >= 2500
        ) {
          clearFrame();
          setStatus(
            error instanceof Error ? error.message : "Camera unavailable",
          );
        }
      } finally {
        polling = false;
      }
    };
    connect();
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    const expiryTimer = setInterval(() => {
      if (source && Date.now() >= expiresAt) {
        clearFrame();
        setStatus("Camera image is out of date. Waiting for a new frame…");
      }
    }, 250);
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(expiryTimer);
      clearTimeout(reconnect);
      controller.abort();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [memberId, preview]);
  return { src, status, live };
}
