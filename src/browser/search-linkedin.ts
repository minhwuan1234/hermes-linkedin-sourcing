import { chromium, type Page } from "playwright";
import path from "node:path";

const profilePath = path.resolve("data", "chrome-profile");

function getArgument(name: string): string {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));

  return argument?.slice(prefix.length).trim() ?? "";
}

async function applyLocationFilter(
  page: Page,
  location: string
): Promise<void> {
  if (!location) {
    return;
  }

  const locationsButton = page.getByRole("button", {
    name: /locations/i
  });

  await locationsButton.waitFor({
    state: "visible",
    timeout: 30_000
  });

  await locationsButton.click();

  const locationInput = page.locator(
    'input[placeholder*="location" i], input[aria-label*="location" i]'
  ).last();

  await locationInput.waitFor({
    state: "visible",
    timeout: 15_000
  });

  await locationInput.fill(location);

  const suggestion = page.getByText(location, {
    exact: false
  }).last();

  await suggestion.waitFor({
    state: "visible",
    timeout: 15_000
  });

  await suggestion.click();

  const showResultsButton = page.getByRole("button", {
    name: /show results/i
  });

  await showResultsButton.click();

  await page.waitForLoadState("domcontentloaded");
}

async function main(): Promise<void> {
  const keyword = getArgument("keyword");
  const location = getArgument("location");

  if (!keyword) {
    throw new Error(
      'Thiếu keyword. Ví dụ: --keyword="AI Automation"'
    );
  }

  const searchUrl = new URL(
    "https://www.linkedin.com/search/results/people/"
  );

  searchUrl.searchParams.set("keywords", keyword);
  searchUrl.searchParams.set(
    "origin",
    "GLOBAL_SEARCH_HEADER"
  );

  const context = await chromium.launchPersistentContext(
    profilePath,
    {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: [
        "--start-maximized",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    }
  );

  const page =
    context.pages()[0] ?? await context.newPage();

  await page.goto(searchUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  await applyLocationFilter(page, location);

  console.log("LinkedIn search opened.");
  console.log(`Keyword: ${keyword}`);
  console.log(
    `Location filter: ${location || "Không sử dụng"}`
  );
  console.log(`URL: ${page.url()}`);
  console.log("Đóng Chrome để kết thúc.");

  await new Promise<void>((resolve) => {
    context.once("close", resolve);
  });
}

main().catch((error: unknown) => {
  console.error("LinkedIn search error:", error);
  process.exit(1);
});
