export const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "1.0.0";
export const APP_VERSION_LABEL = "\u0627\u0644\u0625\u0635\u062f\u0627\u0631";

export function formatAppVersion() {
  return `${APP_VERSION_LABEL} ${APP_VERSION}`;
}
