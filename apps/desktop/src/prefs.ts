/** The settings the window can show and change, with the values each one may take. */
export type Theme = "system" | "light" | "dark";
export const THEMES: Theme[] = ["system", "light", "dark"];
/** how far back the agents list reaches, in hours */
export const SINCE_HOURS = [1, 3, 6, 12, 24];
/** how many closed cards stay readable; 0 keeps none */
export const KEEP_CLOSED = [0, 10, 20, 50];

export interface Prefs {
  /** follow the system's light or dark appearance, or keep one */
  theme: Theme;
  notify: boolean;
  openAtLogin: boolean;
  sinceHours: number;
  keepClosed: number;
}

/** Whether `value` is something `key` may be set to. */
export function validPref<K extends keyof Prefs>(key: K, value: unknown): value is Prefs[K] {
  switch (key) {
    case "theme":
      return THEMES.includes(value as Theme);
    case "notify":
    case "openAtLogin":
      return typeof value === "boolean";
    case "sinceHours":
      return SINCE_HOURS.includes(value as number);
    case "keepClosed":
      return KEEP_CLOSED.includes(value as number);
    default:
      return false;
  }
}
