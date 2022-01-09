require('dotenv').config();
const env = require('env-var');
const express = require("express");
const app = express();

const PORT = env.get('APP_PORT').default(3001).asInt();

const { google } = require("googleapis");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(env.get('GOOGLE_SERVICE_ACCOUNT').required().asString()),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

const Cache = new Map();

app.use(
  require("morgan")(":method :url :status - :response-time ms (via :referrer)")
);

const corsOptions = function (req, callback) {
  let opts;
  const origin = req.headers.origin;

  const useWhitelist = env.get('USE_WHITELIST').default('false').asBool();
  const whitelistUrls = env.get('WHITELIST_ORIGIN').asString().split(',');

  if (whitelistUrls.indexOf(origin) !== -1 || !useWhitelist) {
    opts = { origin: true };
  } else {
    opts = { origin: false };
  }
  callback(null, opts);
}
app.use(require("cors")(corsOptions));

app.get("/", async (req, res) => {
  res.redirect("https://github.com/hrz8/opensheet#readme");
});

app.get("/:id/:sheet", async (req, res) => {
  let { id, sheet } = req.params;
  // This is what Vercel does, and we want to keep this behavior
  // even after migrating off of Vercel so there's no breaking change.
  sheet = sheet.replace(/\+/g, " ");

  const cacheKey = `${id}--${sheet}`;
  if (Cache.has(cacheKey)) {
    const result = Cache.get(cacheKey);
    console.info(`[CACHED] responding thru cache: ${result}`);
    return res.json(JSON.parse(result));
  }

  if (!isNaN(sheet)) {
    let data;
    try {
      const response = await sheets.spreadsheets.get({
        spreadsheetId: id,
      });
      data = response.data;
    } catch (error) {
      return res.json({ error: error.response.data.error.message });
    }

    if (parseInt(sheet) === 0) {
      return res.json({ error: "For this API, sheet numbers start at 1" });
    }

    const sheetIndex = parseInt(sheet) - 1;

    if (!data.sheets[sheetIndex]) {
      return res.json({ error: `There is no sheet number ${sheet}` });
    }

    sheet = data.sheets[sheetIndex].properties.title;
  }

  sheets.spreadsheets.values.get(
    {
      spreadsheetId: id,
      range: sheet,
    },
    async (error, result) => {
      if (error) {
        return res.json({ error: error.response.data.error.message });
      }

      const rows = [];

      const rawRows = result.data.values || [];
      const headers = rawRows.shift();

      rawRows.forEach((row) => {
        const rowData = {};
        row.forEach((item, index) => {
          rowData[headers[index]] = item;
        });
        rows.push(rowData);
      });

      Cache.set(cacheKey, JSON.stringify(rows));
      setTimeout(() => {
        Cache.delete(cacheKey);
      }, 300000);

      console.info(`[FRESHED] responding directly from sheets: ${JSON.stringify(rows)}`);
      return res.json(rows);
    }
  );
});

app.delete("/cache/:id", async (req, res) => {
  let { id: cacheKey } = req.params;
  const exist = Cache.get(cacheKey);
  if (!exist) {
    console.info(`[SKIPPED] no cache with key: ${cacheKey}`);
    return res.json({status: 'skipped'});
  }
  Cache.delete(cacheKey);
  console.info(`[DELETED] manually clear the cache with key: ${cacheKey}`);
  return res.json({status: 'ok'});
});

app.listen(process.env.PORT || PORT, () => console.log(`http://localhost:${PORT}`));

// Avoid a single error from crashing the server in production.
process.on("uncaughtException", (...args) => console.error(args));
process.on("unhandledRejection", (...args) => console.error(args));
