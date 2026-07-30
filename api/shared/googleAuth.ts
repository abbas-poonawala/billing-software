import { google } from "googleapis";

export function createGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: (() => {
      try {
        return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!);
      } catch (err) {
        console.error("[init_error] failed to parse service account:", err);
        throw new Error("Invalid google service account credentials.");
      }
    })(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}
