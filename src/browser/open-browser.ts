import { chromium } from "playwright";
import path from "node:path";

const profilePath = path.resolve("data", "chrome-profile");

async function main(): Promise<void> {
  console.log("Opening Chrome...");

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: [
      "--start-maximized",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  const page = context.pages()[0] ?? await context.newPage();

  await page.goto("https://www.linkedin.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  console.log("LinkedIn opened.");
  console.log("Log in manually. The session will be saved locally.");
  console.log("Close Chrome when finished.");

  await new Promise<void>((resolve) => {
    context.once("close", () => resolve());
  });
}

main().catch((error: unknown) => {
  console.error("Browser error:", error);
  process.exit(1);
});
