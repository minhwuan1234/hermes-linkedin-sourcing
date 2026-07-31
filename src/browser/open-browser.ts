import { chromium, type BrowserContext } from "playwright";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT = process.cwd();

const USER_DATA_DIR = path.join(
  PROJECT_ROOT,
  "data",
  "chrome-profile"
);

async function openBrowser(): Promise<void> {
  let context: BrowserContext | undefined;

  try {
    console.log("Starting Google Chrome...");
    console.log(`Profile directory: ${USER_DATA_DIR}`);

    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: [
        "--start-maximized",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    });

    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();

    await page.goto("https://www.google.com", {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });

    console.log("Chrome opened successfully.");
    console.log(`Current URL: ${page.url()}`);
    console.log("Press Ctrl+C in the terminal to close Chrome.");

    await new Promise<void>((resolve) => {
      context?.once("close", resolve);

      process.once("SIGINT", async () => {
        console.log("\nClosing Chrome...");
        await context?.close();
        resolve();
      });
    });
  } catch (error: unknown) {
    console.error("Failed to open Chrome.");

    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }

    await context?.close().catch(() => undefined);
    process.exitCode = 1;
  }
}

void openBrowser();
