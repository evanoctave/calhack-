import { isPreviewMode, previewRequest } from "./preview";

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function messageFor(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((item: { msg?: string }) => item.msg || "Invalid value")
      .join(". ");
  return `Request failed (${status}). Please try again.`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new ApiError(400, "Use a same-origin API path.");
  // Preview is an explicit, isolated experience. It must never call the connected backend.
  if (isPreviewMode()) {
    try {
      return await previewRequest<T>(path, init);
    } catch (error) {
      if (error instanceof Error && "status" in error)
        throw new ApiError(Number(error.status), error.message);
      throw error;
    }
  }
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...init });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "Cannot reach Nightfall. Check the connection and try again.",
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok)
      throw new ApiError(
        response.status,
        "Nightfall returned an unexpected response.",
      );
    body = undefined;
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? body.detail
        : undefined;
    throw new ApiError(
      response.status,
      messageFor(detail, response.status),
      detail,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, options?: RequestInit) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  upload: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
