import { createWorker, Worker } from "tesseract.js";
import {
  addScheduleFlag,
  applyQuantityVerificationFlag,
  needsScheduleReview,
  type QuantityVerificationStatus,
} from "./scheduleReview";

export interface ScheduleItem {
  planCallout: string;
  description: string;
  manufacturer: string;
  rawModel: string;
  modelNumber: string;
  quantity: number;
  sourceSection: string;
  confidence: number;
  flags: string[];
  needsReview: boolean;
  quantityVerification: QuantityVerificationStatus;
}

export interface ExtractionResult {
  items: ScheduleItem[];
  rawText: string;
  processingTimeMs: number;
}

let scheduleOcrWorker: Worker | null = null;

async function getScheduleOcrWorker(): Promise<Worker> {
  if (!scheduleOcrWorker) {
    scheduleOcrWorker = await createWorker("eng");
  }
  return scheduleOcrWorker;
}

const SCHEDULE_HEADER_PATTERN = /\b(APPLIANCE\s+SCHEDULE|ACCESSORY\s+SCHEDULE|PLUMBING\s+FIXTURE|TOILET\s+ACCESSOR|EQUIPMENT\s+SCHEDULE|FIXTURE\s+SCHEDULE|FURNISHING\s+SCHEDULE|SCHEDULE\s+OF\s+\w+)/i;

const CALLOUT_PATTERN = /^([A-Z]{1,4}-?\d{1,3}[A-Z]?)\b/;

const VALID_CALLOUT_PATTERN = /^[A-Z]{2,4}-?\d{1,3}[A-Z]?$/;

const KNOWN_MANUFACTURERS = [
  "bobrick", "asi", "bradley", "kohler", "moen", "american standard",
  "delta", "toto", "sloan", "zurn", "elkay", "frigidaire", "ge",
  "whirlpool", "samsung", "lg", "bosch", "kitchenaid", "maytag",
  "sub-zero", "wolf", "viking", "thermador", "jl industries",
  "larsen", "potter roemer", "guardian", "halsey taylor", "haws",
  "oasis", "franke", "grohe", "hansgrohe", "insinkerator",
  "waste king", "broan", "nutone", "panasonic", "greenheck",
  "bobrick", "gamco", "frost", "scott", "kimberly-clark",
  "georgia-pacific", "dyson", "excel dryer", "world dryer",
];

const MODEL_PATTERN = /\b([A-Z]{1,3}[-]?\d{2,}[-A-Z0-9]*)\b/i;

function formatModelNumber(manufacturer: string, rawModel: string, flags: string[]): string {
  const mfr = manufacturer.trim();
  const model = rawModel.trim();

  if (!mfr && !model) {
    flags.push("Model missing", "Manufacturer missing");
    return "";
  }

  if (!mfr && model) {
    flags.push("Manufacturer missing");
    return model;
  }

  if (mfr && !model) {
    flags.push("Model missing");
    return mfr;
  }

  if (mfr.toLowerCase() === "bobrick" && /^B-?\d/.test(model)) {
    const normalizedModel = model.startsWith("B-") ? model : "B-" + model.substring(1);
    return normalizedModel;
  }

  return `${mfr} ${model}`;
}

function isModelUncertain(model: string): boolean {
  if (!model) return true;
  if (model.length < 3) return true;
  if (/^\d+$/.test(model)) return true;
  return false;
}

function parseScheduleText(rawText: string): ScheduleItem[] {
  const lines = rawText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  const items: ScheduleItem[] = [];
  let currentSection = "UNKNOWN SCHEDULE";
  let pendingItem: Partial<ScheduleItem> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const headerMatch = line.match(SCHEDULE_HEADER_PATTERN);
    if (headerMatch) {
      if (pendingItem && pendingItem.planCallout) {
        items.push(finalizePendingItem(pendingItem, currentSection));
        pendingItem = null;
      }
      currentSection = line.toUpperCase().trim();
      continue;
    }

    const calloutMatch = line.match(CALLOUT_PATTERN);
    if (calloutMatch) {
      if (pendingItem && pendingItem.planCallout) {
        items.push(finalizePendingItem(pendingItem, currentSection));
      }

      const callout = calloutMatch[1];
      const remainder = line.substring(calloutMatch[0].length).trim();
      const parsed = parseLineFields(remainder);

      pendingItem = {
        planCallout: callout,
        description: parsed.description,
        manufacturer: parsed.manufacturer,
        rawModel: parsed.rawModel,
        quantity: parsed.quantity,
        flags: [],
      };
    } else if (pendingItem) {
      const hasContent = /[A-Za-z]/.test(line);
      const looksLikeContinuation = hasContent && !CALLOUT_PATTERN.test(line);
      if (looksLikeContinuation) {
        pendingItem.description = ((pendingItem.description || "") + " " + line).trim();
      }
    }
  }

  if (pendingItem && pendingItem.planCallout) {
    items.push(finalizePendingItem(pendingItem, currentSection));
  }

  const calloutCounts: Record<string, number> = {};
  for (const item of items) {
    calloutCounts[item.planCallout] = (calloutCounts[item.planCallout] || 0) + 1;
  }
  for (const item of items) {
    if (calloutCounts[item.planCallout] > 1) {
      addScheduleFlag(item.flags, "Possible duplicate callout");
      item.needsReview = needsScheduleReview(item);
    }
  }

  return items;
}

function parseLineFields(remainder: string): {
  description: string;
  manufacturer: string;
  rawModel: string;
  quantity: number | undefined;
} {
  let quantity: number | undefined;
  let description = "";
  let manufacturer = "";
  let rawModel = "";

  const qtyMatch = remainder.match(/\b(\d{1,4})\s*$/);
  let mainPart = remainder;
  if (qtyMatch) {
    quantity = parseInt(qtyMatch[1], 10);
    mainPart = remainder.substring(0, remainder.length - qtyMatch[0].length).trim();
  }

  const parts = mainPart.split(/\s{2,}|\t+/);

  if (parts.length >= 3) {
    description = parts[0].trim();
    manufacturer = parts[1].trim();
    rawModel = parts.slice(2).join(" ").trim();
    if (!quantity && parts.length >= 4) {
      const q = parseInt(parts[parts.length - 1].trim(), 10);
      if (!isNaN(q)) {
        quantity = q;
        rawModel = parts.slice(2, parts.length - 1).join(" ").trim();
      }
    }
  } else {
    const result = extractFieldsFromSingleSpaced(mainPart);
    description = result.description;
    manufacturer = result.manufacturer;
    rawModel = result.rawModel;
  }

  return { description, manufacturer, rawModel, quantity };
}

function extractFieldsFromSingleSpaced(text: string): {
  description: string;
  manufacturer: string;
  rawModel: string;
} {
  let manufacturer = "";
  let rawModel = "";
  let description = text;

  const modelMatch = text.match(/\b([A-Z]{1,3}[-]?\d{2,}[-A-Z0-9]*)\b/i);

  if (modelMatch) {
    const modelIdx = text.indexOf(modelMatch[1]);
    rawModel = modelMatch[1];

    const beforeModel = text.substring(0, modelIdx).trim();

    const words = beforeModel.split(/\s+/);

    let mfrFound = false;
    for (let i = words.length - 1; i >= 0; i--) {
      const candidateWords: string[] = [];
      for (let j = i; j < words.length; j++) {
        candidateWords.push(words[j]);
        const candidate = candidateWords.join(" ").toLowerCase();
        if (KNOWN_MANUFACTURERS.includes(candidate)) {
          manufacturer = candidateWords.join(" ");
          description = words.slice(0, i).join(" ");
          mfrFound = true;
          break;
        }
      }
      if (mfrFound) break;
    }

    if (!mfrFound) {
      if (words.length >= 2) {
        manufacturer = words[words.length - 1];
        description = words.slice(0, -1).join(" ");
      } else if (words.length === 1) {
        description = "";
        manufacturer = words[0];
      }
    }
  } else {
    let mfrFound = false;
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const candidateWords: string[] = [];
      for (let j = i; j < words.length; j++) {
        candidateWords.push(words[j]);
        const candidate = candidateWords.join(" ").toLowerCase();
        if (KNOWN_MANUFACTURERS.includes(candidate)) {
          manufacturer = candidateWords.join(" ");
          description = words.slice(0, i).join(" ");
          rawModel = words.slice(j + 1).join(" ");
          mfrFound = true;
          break;
        }
      }
      if (mfrFound) break;
    }

    if (!mfrFound) {
      description = text;
    }
  }

  return { description, manufacturer, rawModel };
}

function finalizePendingItem(pending: Partial<ScheduleItem>, sourceSection: string): ScheduleItem {
  const flags: string[] = [...(pending.flags || [])];

  const modelNumber = formatModelNumber(
    pending.manufacturer || "",
    pending.rawModel || "",
    flags
  );

  if (isModelUncertain(pending.rawModel || "")) {
    if (!flags.includes("Model missing")) {
      flags.push("Model uncertain");
    }
  }

  const callout = pending.planCallout || "";
  if (!VALID_CALLOUT_PATTERN.test(callout)) {
    flags.push("Callout uncertain");
  }

  let quantity = pending.quantity ?? 0;
  if (pending.quantity === undefined || pending.quantity === null || isNaN(pending.quantity)) {
    flags.push("Quantity uncertain");
    quantity = 0;
  }

  const quantityVerification: QuantityVerificationStatus = "unverified";
  applyQuantityVerificationFlag(flags, quantityVerification);

  let confidence = 95;

  if (flags.includes("Callout uncertain")) confidence -= 15;
  if (flags.includes("Model uncertain") || flags.includes("Model missing")) confidence -= 15;
  if (flags.includes("Manufacturer missing")) confidence -= 10;
  if (flags.includes("Quantity uncertain")) confidence -= 15;
  if (flags.includes("Possible duplicate callout")) confidence -= 5;
  if (quantityVerification === "unverified" && confidence > 85) confidence = 85;

  confidence = Math.max(0, Math.min(100, confidence));

  const reviewState = { confidence, flags, quantityVerification };

  return {
    planCallout: callout,
    description: pending.description || "",
    manufacturer: pending.manufacturer || "",
    rawModel: pending.rawModel || "",
    modelNumber,
    quantity,
    sourceSection,
    confidence,
    flags,
    quantityVerification,
    needsReview: needsScheduleReview(reviewState),
  };
}

export async function extractScheduleFromImage(imageBuffer: Buffer): Promise<ExtractionResult> {
  const startTime = Date.now();

  const worker = await getScheduleOcrWorker();
  const result = await worker.recognize(imageBuffer);
  const rawText = result.data.text;

  const items = parseScheduleText(rawText);

  const processingTimeMs = Date.now() - startTime;

  return {
    items,
    rawText,
    processingTimeMs,
  };
}

export async function cleanupScheduleOcrWorker(): Promise<void> {
  if (scheduleOcrWorker) {
    await scheduleOcrWorker.terminate();
    scheduleOcrWorker = null;
  }
}
