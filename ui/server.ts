import "dotenv/config";
import express from "express";
import path from "node:path";

const app = express();

const port = Number(process.env.PORT || 3000);
const publicDir = path.resolve("public");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("Missing SUPABASE_URL");
}

if (!supabaseAnonKey) {
  throw new Error("Missing SUPABASE_ANON_KEY");
}

app.use(express.static(publicDir));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.get("/config.js", (_request, response) => {
  response
    .type("application/javascript")
    .send(`
      window.APP_CONFIG = ${JSON.stringify({
        supabaseUrl,
        supabaseAnonKey
      })};
    `);
});

app.use((_request, response) => {
  response.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Dashboard running on port ${port}`);
});
