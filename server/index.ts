import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedDefaultData } from "./seedData";
import path from "path";

const app = express();
const httpServer = createServer(app);

app.set("trust proxy", 1);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

const PgStore = connectPgSimple(session);
app.use(
  session({
    store: new PgStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" as const : "lax" as const,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await seedDefaultData();

  if (process.env.NODE_ENV === "development") {
    const { runDevSeed } = await import("./devSeed");
    await runDevSeed();
  }

  // Always seed permanent accounts (dev + production)
  const { seedPermanentAccounts } = await import("./seedPermanentAccounts");
  await seedPermanentAccounts();

  // Initialize permissions table
  const { initializePermissions } = await import("./permissionsInit");
  await initializePermissions();

  const { runDataRepairs } = await import("./dataRepair");
  await runDataRepairs();

  await registerRoutes(httpServer, app);

  const { startNightlyBackup } = await import("./nightlyBackup");
  startNightlyBackup();

  const { isGoogleSheetConfigured, syncProposalLogToSheet } = await import("./googleSheetSync");
  if (isGoogleSheetConfigured()) {
    syncProposalLogToSheet().then(() => {
      console.log("[Startup] Pushed repaired statuses to Google Sheet");
    }).catch(err => {
      console.error("[Startup] Failed to push repaired statuses to sheet:", err.message);
    });
  }

  app.use("/tools", express.static(path.join(process.cwd(), "public", "tools"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }));

  app.use("/templates", express.static(path.join(process.cwd(), "public", "templates"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".xlsx")) {
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
      }
    }
  }));

  const logPortfolioVisit = async (req: Request) => {
    try {
      const { db } = await import("./db");
      const { portfolioVisits } = await import("@shared/schema");
      const ipHeader = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
      const ip = ipHeader.split(",")[0].trim();
      await db.insert(portfolioVisits).values({
        ip: ip || null,
        userAgent: (req.headers["user-agent"] as string) || null,
        referer: (req.headers["referer"] as string) || (req.headers["referrer"] as string) || null,
        acceptLanguage: (req.headers["accept-language"] as string) || null,
        path: req.path,
      });
    } catch (err) {
      // Silent failure — never break the page render for tracking
    }
  };

  app.get("/portfolio", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    void logPortfolioVisit(req);
    res.sendFile(path.join(process.cwd(), "public", "portfolio", "index.html"));
  });
  app.get("/portfolio/index.html", (_req, res) => {
    res.redirect(301, "/portfolio");
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Error-handling middleware MUST be registered last so it catches errors
  // raised by any preceding middleware (API routes, static, vite catch-all).
  const { captureError: captureRouteError } = await import("./errorCapture");
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    if (status >= 500) {
      void captureRouteError({
        errorType: "backend_uncaught",
        errorMessage: message,
        stackTrace: err?.stack ?? null,
        endpoint: `${req.method} ${req.path}`,
        userId: (req.session as any)?.userId ?? null,
        pageUrl: req.get("referer") ?? null,
        metadata: {
          status,
          name: err?.name,
        },
      });
      console.error(`[error-middleware] ${req.method} ${req.path} → ${status}:`, err?.message, err?.stack);
    }

    if (!res.headersSent) {
      res.status(status).json({ message });
    }
  });

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );

  const shutdown = (signal: string) => {
    log(`received ${signal}, closing server...`);
    httpServer.close(() => {
      log("server closed, exiting");
      process.exit(0);
    });
    setTimeout(() => {
      log("forced exit after 5s timeout");
      process.exit(1);
    }, 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
