/** Navigation hints only. Readiness and saved care data always come from the server. */
export type SetupStep = "profile" | "contacts" | "voice" | "connect";
export type ReturnDestination =
  "/home" | "/care" | "/setup/connect" | "/setup/profile";

const steps: SetupStep[] = ["profile", "contacts", "voice", "connect"];
const destinations: ReturnDestination[] = [
  "/home",
  "/care",
  "/setup/connect",
  "/setup/profile",
];

export function returnDestination(search: string): ReturnDestination {
  const value = new URLSearchParams(search).get("returnTo");
  return destinations.includes(value as ReturnDestination)
    ? (value as ReturnDestination)
    : "/care";
}

export function editSetupPath(
  step: string,
  returnTo: ReturnDestination = "/care",
) {
  return `/setup/${step}?mode=edit&returnTo=${encodeURIComponent(returnTo)}`;
}

const progressKey = (preview: boolean, memberId: string) =>
  `nightfall-setup-v1:${preview ? "preview" : "connected"}:${memberId}`;

export function rememberSetupStep(
  step: SetupStep,
  preview: boolean,
  memberId: string,
) {
  try {
    sessionStorage.setItem(progressKey(preview, memberId), step);
  } catch {
    /* Optional navigation hint. */
  }
}

export function resumedSetupStep(
  preview: boolean,
  memberId: string,
): SetupStep {
  try {
    const value = sessionStorage.getItem(progressKey(preview, memberId));
    if (steps.includes(value as SetupStep)) return value as SetupStep;
  } catch {
    /* Storage may be unavailable. */
  }
  return "profile";
}
