import { useCallback, useEffect, useRef, useState } from "react";
import {
  audioContext,
  getMicrophone,
  socketUrl,
  toPcm16,
  userMediaError,
} from "./media";

type Direction = "talking" | "listening";
type ChannelState = "off" | "connecting" | "on";
type Resources = {
  socket?: WebSocket;
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  gain?: GainNode;
};

export function useDoorAudio(
  memberId: string,
  preview: boolean,
  onStopped?: () => void,
) {
  const [channels, setChannels] = useState<Record<Direction, ChannelState>>({
    talking: "off",
    listening: "off",
  });
  const [errors, setErrors] = useState<Record<Direction, string>>({
    talking: "",
    listening: "",
  });
  const resources = useRef<Record<Direction, Resources>>({
    talking: {},
    listening: {},
  });
  const generation = useRef({ talking: 0, listening: 0 });
  const alive = useRef(true);
  const stoppedRef = useRef(onStopped);
  stoppedRef.current = onStopped;
  const stopChannel = useCallback((direction: Direction) => {
    generation.current[direction]++;
    const current = resources.current[direction];
    resources.current[direction] = {};
    if (current.socket) {
      current.socket.onopen = null;
      current.socket.onclose = null;
      current.socket.onerror = null;
      current.socket.onmessage = null;
      current.socket.close();
    }
    if (current.processor) current.processor.onaudioprocess = null;
    current.processor?.disconnect();
    current.source?.disconnect();
    current.gain?.disconnect();
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.context) current.context.onstatechange = null;
    if (current.context && current.context.state !== "closed")
      void current.context.close().catch(() => undefined);
    if (alive.current)
      setChannels((value) => ({ ...value, [direction]: "off" }));
  }, []);
  const stop = useCallback(
    (direction?: Direction) => {
      if (direction) stopChannel(direction);
      else {
        stopChannel("talking");
        stopChannel("listening");
      }
    },
    [stopChannel],
  );

  const start = useCallback(
    async (direction: Direction) => {
      stop(direction);
      const setError = (message: string) => {
        if (alive.current)
          setErrors((value) => ({ ...value, [direction]: message }));
      };
      setError("");
      if (preview) {
        setError("Preview only. Connect to Nightfall to use live audio.");
        return;
      }
      const run = generation.current[direction];
      const isCurrent = () =>
        alive.current && generation.current[direction] === run;
      setChannels((value) => ({ ...value, [direction]: "connecting" }));
      try {
        const context = audioContext();
        const owned = resources.current[direction];
        owned.context = context;
        await context.resume();
        if (!isCurrent()) return;
        const paused = () => {
          if (!isCurrent() || context.state === "running") return;
          stop(direction);
          setError(
            `${direction === "talking" ? "Talk" : "Listen"} audio is paused. Tap to reconnect.`,
          );
          stoppedRef.current?.();
        };
        if (context.state !== "running") {
          paused();
          return;
        }
        context.onstatechange = paused;
        let stream: MediaStream | undefined;
        if (direction === "talking") {
          stream = await getMicrophone();
          if (!isCurrent()) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          owned.stream = stream;
        }
        const socket = new WebSocket(
          socketUrl(
            `/ws/${direction === "talking" ? "talk" : "listen"}/${encodeURIComponent(memberId)}`,
          ),
        );
        socket.binaryType = "arraybuffer";
        owned.socket = socket;
        let nextTime = 0;
        socket.onopen = () => {
          if (!isCurrent()) return;
          if (context.state !== "running") {
            paused();
            return;
          }
          setChannels((value) => ({ ...value, [direction]: "on" }));
        };
        socket.onerror = () => {
          if (isCurrent()) {
            stop(direction);
            setError(
              `Could not connect ${direction === "talking" ? "Talk" : "Listen"}. Try again.`,
            );
            stoppedRef.current?.();
          }
        };
        socket.onclose = () => {
          if (!isCurrent()) return;
          stop(direction);
          setError(
            `${direction === "talking" ? "Talk" : "Listen"} disconnected. Tap to reconnect.`,
          );
          stoppedRef.current?.();
        };
        if (stream) {
          const source = context.createMediaStreamSource(stream);
          // A muted processing graph keeps the microphone out of the phone speaker.
          const processor = context.createScriptProcessor(2048, 1, 1),
            gain = context.createGain();
          gain.gain.value = 0;
          Object.assign(owned, { source, processor, gain });
          processor.onaudioprocess = (event) => {
            if (
              !isCurrent() ||
              socket.readyState !== WebSocket.OPEN ||
              socket.bufferedAmount > 64000
            )
              return;
            socket.send(
              toPcm16(event.inputBuffer.getChannelData(0), context.sampleRate)
                .buffer,
            );
          };
          source.connect(processor);
          processor.connect(gain);
          gain.connect(context.destination);
        } else {
          socket.onmessage = (event) => {
            if (
              !isCurrent() ||
              !(event.data instanceof ArrayBuffer) ||
              !event.data.byteLength ||
              event.data.byteLength % 2 ||
              context.state === "closed"
            )
              return;
            const pcm = new Int16Array(event.data),
              buffer = context.createBuffer(1, pcm.length, 16000);
            const channel = buffer.getChannelData(0);
            for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
            const node = context.createBufferSource();
            node.buffer = buffer;
            node.connect(context.destination);
            if (
              nextTime < context.currentTime + 0.03 ||
              nextTime > context.currentTime + 0.8
            )
              nextTime = context.currentTime + 0.1;
            node.start(nextTime);
            nextTime += buffer.duration;
            node.onended = () => node.disconnect();
          };
        }
      } catch (cause) {
        if (isCurrent()) {
          stop(direction);
          setError(userMediaError(cause));
        }
      }
    },
    [memberId, preview, stop],
  );
  useEffect(() => {
    alive.current = true;
    setChannels({ talking: "off", listening: "off" });
    setErrors({ talking: "", listening: "" });
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      stop();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [memberId, preview, stop]);
  return {
    channels,
    error: [errors.talking, errors.listening].filter(Boolean).join(" "),
    stop,
    start,
  };
}
