require('dotenv').config();
const env = require('env-var');

// - ENVS
const APP_PORT = env.get('APP_PORT').default(3001).asInt();
const USE_WHITELIST = env.get('USE_WHITELIST').default('false').asBool();
const WHITELIST_ORIGIN = env.get('WHITELIST_ORIGIN').asString();
const GOOGLE_SERVICE_ACCOUNT = env.get('GOOGLE_SERVICE_ACCOUNT').required().asString();
const GOOGLE_SERVICE_MODE = env.get('GOOGLE_SERVICE_MODE').default('spreadsheets.readonly').asString();

// - CACHE
const ONE_SECOND = 1000
const ONE_MINUTE = ONE_SECOND * 60
const Cache = new Map();

// - EXPRESS
const express = require("express");
const app = express();

// - GOOGLE SERVICE
const { google } = require("googleapis");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT),
  scopes: [`https://www.googleapis.com/auth/${GOOGLE_SERVICE_MODE}`],
});
const sheets = google.sheets({ version: "v4", auth });

// - HELPERS
const validateSheetId = async (sheet) => {
  if (!isNaN(sheet)) {
    // if sheetId is number
    let data;
    try {
      const response = await sheets.spreadsheets.get({
        spreadsheetId: id,
      });
      data = response.data;
    } catch (error) {
      throw new Error(error.response.data.error.message);
    }

    if (parseInt(sheet) === 0) {
      throw new Error("For this API, sheet numbers start at 1");
    }

    const sheetIndex = parseInt(sheet) - 1;

    if (!data.sheets[sheetIndex]) {
      throw new Error(`There is no sheet number ${sheet}`);
    }

    sheet = data.sheets[sheetIndex].properties.title;
  }
}

// - MIDDLEWARE
app.use(
  require("morgan")(":method :url :status - :response-time ms (via :referrer)")
);
app.use(express.json());
app.use(require("cors")((req, callback) => {
  let opts;
  const origin = req.headers.origin;
  const whitelistUrls = WHITELIST_ORIGIN.split(',');
  if (whitelistUrls.indexOf(origin) !== -1 || !USE_WHITELIST) {
    opts = { origin: true };
  } else {
    opts = { origin: false };
  }
  callback(null, opts);
}));

// - ENDPOINTS
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

  try {
    validateSheetId(sheet);
  } catch (error) {
    console.error(`[ERROR] when validate sheetId`);
    console.error(error);
    return res.status(400).json({ error: error?.message || 'error' })
  }

  sheets.spreadsheets.values.get(
    {
      spreadsheetId: id,
      range: sheet,
    },
    (error, result) => {
      if (error) {
        return res.status(400).json({ error: error.response.data.error.message });
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
        console.info(`[SCHEDULED] delete cache with key: ${cacheKey}`);
        Cache.delete(cacheKey);
      }, 7 * ONE_MINUTE);

      console.info(`[FRESHED] responding directly from sheets: ${JSON.stringify(rows)}`);
      return res.json(rows);
    }
  );
});

app.post("/:id/:sheet", async (req, res) => {
  let { id, sheet } = req.params;
  // This is what Vercel does, and we want to keep this behavior
  // even after migrating off of Vercel so there's no breaking change.
  sheet = sheet.replace(/\+/g, " ");

  const { body: payload } = req;

  if (!Array.isArray(payload)) {
    return res.status(400).json({ error: 'Payload must be array'});
  }

  try {
    validateSheetId(sheet);
  } catch (error) {
    console.error(`[ERROR] when validate sheetId`);
    console.error(error);
    return res.status(400).json({ error: error?.message || 'error' })
  }

  sheets.spreadsheets.values.append(
    {
      spreadsheetId: id,
      range: `${sheet}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [req.body]
      }
    },
    (error, result) => {
      if (error) {
        return res.status(400).json({ error: error.response.data.error.message });
      }

      const cacheKey = `${id}--${sheet}`;
      if (Cache.has(cacheKey)) {
        console.info(`[UPDATED] delete cache with key: ${cacheKey}`);
        Cache.delete(cacheKey);
      }

      return res.json(result.data);
    }
  )
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

// - APP START
app.listen(process.env.PORT || APP_PORT, () => console.log(`http://localhost:${APP_PORT}`));

// Avoid a single error from crashing the server in production.
process.on("uncaughtException", (...args) => console.error(args));
process.on("unhandledRejection", (...args) => console.error(args));
