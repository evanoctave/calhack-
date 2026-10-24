import { useCallback, useEffect, useRef, useState } from "react";
import {
  audioContext,
  getMicrophone,
  socketUrl,
  toPcm16,
  userMediaError,
} from "./media";

type Mode = "off" | "connecting" | "talking" | "listening";
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
  const [mode, setMode] = useState<Mode>("off");
  const [error, setError] = useState("");
  const resources = useRef<Resources>({});
  const generation = useRef(0);
  const alive = useRef(true);
  const stoppedRef = useRef(onStopped);
  stoppedRef.current = onStopped;
  const stop = useCallback(() => {
    generation.current++;
    const current = resources.current;
    resources.current = {};
    if (current.socket) {
      current.socket.onclose = null;
      current.socket.onerror = null;
      current.socket.close();
    }
    current.processor?.disconnect();
    current.source?.disconnect();
    current.gain?.disconnect();
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.context && current.context.state !== "closed")
      void current.context.close();
    if (alive.current) setMode("off");
  }, []);

  const start = useCallback(
    async (direction: "talking" | "listening") => {
      stop();
      setError("");
      if (preview) {
        setError("Preview only. Connect to Nightfall to use live audio.");
        return;
      }
      const run = generation.current;
      setMode("connecting");
      try {
        const context = audioContext();
        resources.current.context = context;
        await context.resume();
        if (generation.current !== run) return;
        let stream: MediaStream | undefined;
        if (direction === "talking") {
          stream = await getMicrophone();
          if (generation.current !== run) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          resources.current.stream = stream;
        }
        const socket = new WebSocket(
          socketUrl(
            `/ws/${direction === "talking" ? "talk" : "listen"}/${encodeURIComponent(memberId)}`,
          ),
        );
        socket.binaryType = "arraybuffer";
        resources.current.socket = socket;
        let nextTime = 0;
        socket.onopen = () => {
          if (generation.current === run) setMode(direction);
        };
        socket.onerror = () => {
          if (generation.current === run) {
            stop();
            setError("Could not connect the door audio. Try again.");
          }
        };
        socket.onclose = () => {
          if (generation.current !== run) return;
          stop();
          setError("The door audio connection ended. Tap to reconnect.");
          stoppedRef.current?.();
        };
        if (stream) {
          const source = context.createMediaStreamSource(stream);
          // A muted processing graph keeps the microphone out of the phone speaker.
          const processor = context.createScriptProcessor(2048, 1, 1),
            gain = context.createGain();
          gain.gain.value = 0;
          processor.onaudioprocess = (event) => {
            if (
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
          Object.assign(resources.current, { source, processor, gain });
        } else {
          socket.onmessage = (event) => {
            if (
              !(event.data instanceof ArrayBuffer) ||
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
        if (generation.current === run) {
          stop();
          setError(userMediaError(cause));
        }
      }
    },
    [memberId, preview, stop],
  );
  useEffect(() => {
    alive.current = true;
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      stop();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [stop]);
  return { mode, error, stop, start };
}
