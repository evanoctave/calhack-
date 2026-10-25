import { Button, Notice } from "../../components/ui";
import type { useDoorAudio } from "./useDoorAudio";

export function DoorAudioControls({
  audio,
  disabled = false,
  onToggle,
}: {
  audio: ReturnType<typeof useDoorAudio>;
  disabled?: boolean;
  onToggle: (direction: "talking" | "listening") => void;
}) {
  const talk = audio.channels.talking,
    listen = audio.channels.listening;
  return (
    <div className="stack gap-sm">
      <div className="grid-two">
        <Button
          variant={talk !== "off" ? "danger" : "secondary"}
          disabled={disabled}
          aria-pressed={talk !== "off"}
          onClick={() => onToggle("talking")}
        >
          {talk === "connecting"
            ? "Cancel Talk"
            : talk === "on"
              ? "Stop talking"
              : "Talk through the door"}
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          aria-pressed={listen !== "off"}
          onClick={() => onToggle("listening")}
        >
          {listen === "connecting"
            ? "Cancel Listen"
            : listen === "on"
              ? "Stop listening"
              : "Listen"}
        </Button>
      </div>
      <p className="caption" role="status">
        {talk === "connecting" || listen === "connecting"
          ? "Connecting door audio… "
          : ""}
        {talk === "on" ? "Your microphone is live at the door. " : ""}
        {listen === "on"
          ? talk === "on"
            ? "Listen is enabled, but door audio is paused during Talk. Stop talking to hear the reply. "
            : "Listening to the door microphone. "
          : ""}
        {talk === "off" && listen === "off"
          ? "Listen to hear the entrance. Talk through the door sends your own voice."
          : ""}
      </p>
      {audio.error && <Notice tone="warning">{audio.error}</Notice>}
    </div>
  );
}
