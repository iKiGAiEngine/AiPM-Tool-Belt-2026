/**
 * File → text extraction for the quote parser.
 *
 * PDFs with a real text layer are extracted via pdfjs (line-aware, see
 * pdfUtils). PDFs with little or no text (scans/photos saved as PDF) are
 * flagged `scanned: true` so the caller can render their pages to images and
 * use the vision model instead — the old tesseract-OCR path is gone (it
 * depended on a `pdftoppm` binary that was never present in production).
 */
import { extractPdfText } from "../pdfUtils";

export interface ExtractedFileText {
  text: string;
  warnings: string[];
  /** True when the file is a PDF whose pages carry (almost) no text layer. */
  scanned: boolean;
}

// A page of real quote text is comfortably above this; scans produce nothing
// or a handful of stray characters.
const MIN_TEXT_PER_DOC = 50;

export async function extractTextFromFile(buffer: Buffer, mimeType: string): Promise<ExtractedFileText> {
  const warnings: string[] = [];

  if (mimeType === "application/pdf") {
    try {
      const data = await extractPdfText(buffer);
      if (data.text.trim().length < MIN_TEXT_PER_DOC) {
        warnings.push("PDF appears to be a scan — reading it visually instead.");
        return { text: data.text, warnings, scanned: true };
      }
      return { text: data.text, warnings, scanned: false };
    } catch (error) {
      warnings.push("Could not read the PDF's text layer — reading it visually instead.");
      return { text: "", warnings, scanned: true };
    }
  }

  if (mimeType === "text/plain") {
    return { text: buffer.toString("utf-8"), warnings, scanned: false };
  }

  return { text: "", warnings: [`Unsupported file type: ${mimeType}`], scanned: false };
}
