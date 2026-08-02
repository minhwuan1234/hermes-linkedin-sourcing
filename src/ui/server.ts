import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();

const port = Number(process.env.PORT ?? 3000);

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

// Khi chạy dist/ui/server.js, public nằm ở root project.
const publicDirectory = path.resolve(
  currentDirectory,
  "../../public"
);

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ?? "";

app.get("/health", (_request, response) => {
  response.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.get("/config.js", (_request, response) => {
  response
    .status(200)
    .type("application/javascript")
    .send(`
      window.APP_CONFIG = ${JSON.stringify({
        supabaseUrl,
        supabaseAnonKey
      })};
    `);
});

app.use(express.static(publicDirectory));

app.use((_request, response) => {
  response.sendFile(
    path.join(publicDirectory, "index.html")
  );
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Dashboard listening on 0.0.0.0:${port}`
  );

  console.log(
    `Public directory: ${publicDirectory}`
  );

  console.log(
    `Supabase URL configured: ${Boolean(supabaseUrl)}`
  );

  console.log(
    `Supabase anon key configured: ${Boolean(
      supabaseAnonKey
    )}`
  );
});
