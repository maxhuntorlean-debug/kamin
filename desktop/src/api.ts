import { invoke } from "@tauri-apps/api/core";

export type Noise = "near_field" | "far_field";

export type PublicSettings = {
  hasKey: boolean;
  microphoneId: string;
  noise: Noise;
};

export type KeyCheck = {
  ok: boolean;
  message: string;
};

export function runningInApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getSettings(): Promise<PublicSettings> {
  return invoke("get_settings");
}

export function saveSettings(input: {
  apiKey: string | null;
  microphoneId: string;
  noise: Noise;
}): Promise<PublicSettings> {
  return invoke("save_settings", input);
}

export function checkKey(apiKey: string | null): Promise<KeyCheck> {
  return invoke("check_key", { apiKey });
}

export function openSession(): Promise<string> {
  return invoke("open_session");
}

export function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Не удалось выполнить запрос";
}
