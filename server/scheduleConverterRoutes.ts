import type { Express, Request, Response } from "express";
import multer from "multer";
import { extractScheduleFromImage } from "./scheduleConverter";
import { extractScheduleWithAI, extractScheduleFromText } from "./openaiScheduleExtractor";

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (PNG, JPG) are allowed"));
    }
  },
});

function handleMulterError(req: Request, res: Response, next: Function) {
  imageUpload.single("image")(req, res, (err: any) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Image file too large (max 20MB)" });
      }
      return res.status(400).json({ message: err.message || "Invalid file upload" });
    }
    next();
  });
}

export function registerScheduleConverterRoutes(app: Express) {
  app.post("/api/schedule-converter/extract", handleMulterError, async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image uploaded" });
      }
      const result = await extractScheduleFromImage(req.file.buffer);
      res.json(result);
    } catch (error: any) {
      console.error("Schedule extraction error:", error);
      res.status(500).json({ message: error.message || "Failed to extract schedule" });
    }
  });

  app.post("/api/toolbelt/schedule-to-estimate", async (req: Request, res: Response) => {
    try {
      const { image, mimeType } = req.body || {};

      if (!image || typeof image !== "string") {
        return res.status(400).json({ message: "No image provided" });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ message: "OpenAI API key not configured" });
      }

      const imageBuffer = Buffer.from(image, "base64");
      const resolvedMimeType =
        typeof mimeType === "string" && mimeType.startsWith("image/")
          ? mimeType
          : "image/png";

      const result = await extractScheduleWithAI(imageBuffer, resolvedMimeType);
      res.json(result);
    } catch (error: any) {
      console.error("AI schedule extraction error:", error);
      res.status(500).json({ message: error.message || "Failed to extract schedule with AI" });
    }
  });

  app.post("/api/toolbelt/schedule-text-to-estimate", async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string" || text.trim().length === 0) {
        return res.status(400).json({ message: "No schedule text provided" });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ message: "OpenAI API key not configured" });
      }

      const result = await extractScheduleFromText(text.trim());
      res.json(result);
    } catch (error: any) {
      console.error("Text schedule extraction error:", error);
      res.status(500).json({ message: error.message || "Failed to extract schedule from text" });
    }
  });
}
