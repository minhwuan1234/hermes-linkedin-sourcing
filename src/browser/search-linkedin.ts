import { chromium } from "playwright";
import path from "node:path";

const profilePath = path.resolve("data", "chrome-profile");

function getArgument(name: string): string {
  const prefix = `--${name}=`;
  const argument = process.argv.find((item) => item.startsWith(prefix));

  return argument?.slice(prefix.length).trim() ?? "";
}

async function main(): Promise<void> {
  const keyword = getArgument("keyword");
  const location = getArgument("location");

  if (!keyword) {
    throw new Error('Thiếu keyword. Ví dụ: --keyword="AI Automation"');
  }

  const searchQuery = [keyword, location].filter(Boolean).join(" ");

  const searchUrl = new URL(
    "https://www.linkedin.com/search/results/people/"
  );

  searchUrl.searchParams.set("keywords", searchQuery);
  searchUrl.searchParams.set("origin", "GLOBAL_SEARCH_HEADER");

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--start-maximized"]
  });

  const page = context.pages()[0] ?? await context.newPage();

  await page.goto(searchUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  console.log("LinkedIn search opened.");
  console.log(`Keyword: ${keyword}`);
  console.log(`Location: ${location || "Không có"}`);
  console.log(`URL: ${page.url()}`);
  console.log("Đóng Chrome để kết thúc.");

  await new Promise<void>((resolve) => {
    context.once("close", resolve);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
