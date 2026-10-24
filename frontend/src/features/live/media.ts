/** The existing door relay uses JPEG frames and 16 kHz mono signed PCM. */
export function socketUrl(path: string): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}

export function toPcm16(samples: Float32Array, sampleRate: number): Int16Array {
  const ratio = sampleRate / 16000;
  const output = new Int16Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const from = Math.floor(index * ratio),
      to = Math.max(from + 1, Math.floor((index + 1) * ratio));
    let value = 0;
    for (let i = from; i < to && i < samples.length; i++) value += samples[i];
    value = Math.max(-1, Math.min(1, value / (to - from)));
    output[index] = Math.round(value * (value < 0 ? 32768 : 32767));
  }
  return output;
}

export function audioContext(): AudioContext {
  const AudioConstructor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioConstructor)
    throw new Error(
      "Audio is not supported in this browser. Try Safari or Chrome.",
    );
  return new AudioConstructor();
}

export function supportedRecordingType(): string {
  if (typeof MediaRecorder === "undefined")
    throw new Error(
      "Recording is not supported in this browser. Use typed speech instead.",
    );
  return (
    ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    ) || ""
  );
}

export function userMediaError(error: unknown): string {
  if (
    error instanceof DOMException &&
    ["NotAllowedError", "PermissionDeniedError"].includes(error.name)
  ) {
    return "Microphone access is blocked. Allow it in your browser settings, or use typed speech.";
  }
  return error instanceof Error
    ? error.message
    : "Could not start the microphone. Please try again.";
}

export function getMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia)
    return Promise.reject(
      new Error("A secure HTTPS connection is needed to use the microphone."),
    );
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false,
  });
}
