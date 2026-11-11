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
  /** look for a new version now and then, download it, and offer a restart */
  checkUpdates: boolean;
  /** show each service's own site icon, fetched from its site; off means no fetches at all */
  serviceIcons: boolean;
  /** bring the command line to the app's version with the npm that installed it */
  updateCli: boolean;
}

/** Where the command line stands against the app, for the settings screen. */
export interface CliState {
  /**
   * missing: not used with this data yet; current: same as the app or newer; behind: older than the
   * app; updating: npm is installing `target`; error: the last update failed; idle: between states
   */
  status: "idle" | "missing" | "current" | "behind" | "updating" | "error";
  version?: string;
  path?: string;
  /** the npm that installed it, when it is an npm global install the app can update */
  npm?: string;
  target?: string;
  error?: string;
}

/** Where the app's own update stands, for the settings screen and the menus. */
export interface UpdateState {
  /**
   * off: this build cannot update itself (a development run, or a platform without an update feed);
   * idle: nothing checked yet; latest: this is the newest; available and downloading: a new version
   * is on its way; ready: restart to use it; error: the last check failed
   */
  status: "off" | "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";
  /** the new version, once one is found */
  version?: string;
  /** ready only: an earlier restart to install this version never finished */
  interrupted?: boolean;
  percent?: number;
  error?: string;
  checkedAt?: string;
  /** why updates are off */
  reason?: string;
}

/** What the settings screen shows about this copy and the command line beside it. */
export interface AboutInfo {
  version: string;
  electron: string;
  platform: string;
  /** the command line's note, when it has been used with this store */
  cli?: { version: string; at: string; path?: string };
  /** set when the app and the command line are different versions */
  skew?: string;
  /** whether the app can bring the command line up to date, and how that is going */
  cliUpdate?: CliState;
  logPath: string;
  dataPath: string;
  /** sharing with other machines, when this one shares its log */
  sync?: { device: string; text: string; warn: boolean };
}

/** Whether `value` is something `key` may be set to. */
export function validPref<K extends keyof Prefs>(key: K, value: unknown): value is Prefs[K] {
  switch (key) {
    case "theme":
      return THEMES.includes(value as Theme);
    case "notify":
    case "openAtLogin":
    case "checkUpdates":
    case "serviceIcons":
    case "updateCli":
      return typeof value === "boolean";
    case "sinceHours":
      return SINCE_HOURS.includes(value as number);
    case "keepClosed":
      return KEEP_CLOSED.includes(value as number);
    default:
      return false;
  }
}
