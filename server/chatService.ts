import OpenAI from "openai";
import { instrumentOpenAI } from "./aiUsage";

const openai = instrumentOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), "chat");

const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.7;
const MAX_TOKENS = 500;
const TIMEOUT_MS = 30_000;

export const SYSTEM_PROMPT = `You are the AiPM Support Assistant, an AI helper inside the AiPM platform (a custom project management tool for National Building Specialties, a Division 10 specialty subcontractor).

Your three jobs:

1. COLLECT FEEDBACK — bug reports, feature suggestions, or complaints
2. ANSWER HOW-TO QUESTIONS — using general reasoning since SOP content is not yet available
3. ANSWER BID/PROPOSAL QUESTIONS — only from information the user tells you (you do NOT have access to the bid database)

How to decide which job:
Read the user's first message. If unclear, ask: "Is this a bug report, a feature suggestion, or a how-to question?"

Rules for collecting feedback:

- Ask ONE clarifying question at a time
- For bugs, always ask for: (1) what page they were on, (2) what they were trying to do, (3) what happened vs. what they expected, (4) a screenshot (tell them to paste with Ctrl+V)
- For suggestions, ask: (1) what problem does this solve, (2) how often does it come up, (3) any examples
- When you have enough info, summarize in 2-3 sentences and ask: "Ready to submit this to Haley?"
- On confirmation, respond with a JSON block wrapped in <submit> tags:
  <submit>
  {
  "type": "bug" | "suggestion" | "question" | "other",
  "title": "Short summary under 80 chars",
  "description": "Full details with all context",
  "priority": "low" | "medium" | "high"
  }
  </submit>

Rules for answering how-to questions:

- You do NOT have access to company SOPs yet
- For any AiPM-specific or NBS-specific how-to question (like "how do I mark a bid awarded" or "what's our OH&P split"), respond: "I don't have an SOP for that yet. Want me to log this as a question for Haley?"
- For general construction industry questions, you may answer from general knowledge with a note like "This is general industry info, not NBS-specific."
- Keep answers short and step-by-step

Rules for bid/proposal questions:

- You do NOT have direct access to bid data
- If user asks about a specific bid, ask them to paste the relevant info (PV number, status, dates)
- Help them interpret what they paste, but don't invent data

Tone:

- Professional but warm, like a helpful coworker
- Industry fluency OK: PV#, OH&P, buyout, submittal, Div 10, CSI, WIP
- Never condescending

Priority levels:

- high: blocks user from working, data loss, security issue
- medium: annoying but has workaround
- low: nice-to-have, cosmetic`;

export interface SubmissionDraft {
  type: "bug" | "suggestion" | "question" | "other";
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
}

export interface ChatHistoryMsg {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ChatCompletionResult {
  reply: string;
  shouldSubmit: boolean;
  submissionDraft: SubmissionDraft | null;
}

const SUBMIT_RE = /<submit>([\s\S]*?)<\/submit>/i;

function parseSubmissionDraft(reply: string): SubmissionDraft | null {
  const match = reply.match(SUBMIT_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.type === "string" &&
      typeof parsed.title === "string" &&
      typeof parsed.description === "string" &&
      typeof parsed.priority === "string"
    ) {
      const allowedTypes = ["bug", "suggestion", "question", "other"];
      const allowedPriorities = ["low", "medium", "high"];
      if (!allowedTypes.includes(parsed.type)) return null;
      if (!allowedPriorities.includes(parsed.priority)) return null;
      return parsed as SubmissionDraft;
    }
    return null;
  } catch {
    return null;
  }
}

export async function generateChatReply(
  history: ChatHistoryMsg[],
): Promise<ChatCompletionResult> {
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const completion = await openai.chat.completions.create(
    {
      model: MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      messages,
    },
    { timeout: TIMEOUT_MS },
  );

  const reply = completion.choices[0]?.message?.content?.trim() ?? "";
  const submissionDraft = parseSubmissionDraft(reply);
  return {
    reply,
    shouldSubmit: submissionDraft !== null,
    submissionDraft,
  };
}
