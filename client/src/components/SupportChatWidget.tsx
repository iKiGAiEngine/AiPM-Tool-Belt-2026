import { useState, useEffect, useRef } from "react";
import { MessageCircle, X, Send, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";

const PLAYFAIR = "'Playfair Display', serif";
const RAJDHANI = "'Rajdhani', sans-serif";

const GREETING =
  "Hi! I'm the AiPM Support Assistant. I can help you with three things: reporting bugs, suggesting features, or answering how-to questions. What can I help you with?";
const ERROR_REPLY =
  "Sorry, I had trouble responding. Please try again.";

const SESSION_ID_KEY = "aipm-chat-session-id";
const MESSAGES_KEY = "aipm-chat-messages";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
}

function loadMessages(): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMessages(msgs: ChatMessage[]) {
  try {
    sessionStorage.setItem(MESSAGES_KEY, JSON.stringify(msgs));
  } catch {
    /* ignore quota errors */
  }
}

function ensureSessionId(): string {
  let id = sessionStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function SupportChatWidget() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages());
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openPanel = () => {
    if (!sessionIdRef.current) {
      sessionIdRef.current = ensureSessionId();
    }
    setMessages((prev) => {
      if (prev.length === 0) {
        const greeting: ChatMessage = {
          id: newId(),
          role: "assistant",
          text: GREETING,
          ts: Date.now(),
        };
        const next = [greeting];
        saveMessages(next);
        return next;
      }
      return prev;
    });
    setMounted(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 250);
      });
    });
  };

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (mounted && open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping, open, mounted]);

  useEffect(() => {
    if (mounted && !open) {
      const t = window.setTimeout(() => setMounted(false), 320);
      return () => window.clearTimeout(t);
    }
  }, [open, mounted]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isTyping) return;
    const userMsg: ChatMessage = {
      id: newId(),
      role: "user",
      text,
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setIsTyping(true);
    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          message: text,
          pageUrl: typeof window !== "undefined" ? window.location.pathname : null,
          hasScreenshot: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        reply: string;
        sessionId: string;
        shouldSubmit: boolean;
        submissionDraft: unknown;
      };
      if (data.sessionId && data.sessionId !== sessionIdRef.current) {
        sessionIdRef.current = data.sessionId;
        try {
          sessionStorage.setItem(SESSION_ID_KEY, data.sessionId);
        } catch {
          /* ignore */
        }
      }
      const aiMsg: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: data.reply || ERROR_REPLY,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const aiMsg: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: ERROR_REPLY,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const _hasImage = items.some((it) => it.type.startsWith("image/"));
    // Step 6 will wire actual screenshot upload
  };

  const handlePaperclipClick = () => {
    // paperclip clicked
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title="Support Chat"
        onClick={openPanel}
        data-testid="button-support-chat-open"
      >
        <MessageCircle className="h-4 w-4" />
      </Button>

      {mounted && (
      <div
        className={`fixed top-0 right-0 h-screen z-50 w-full sm:w-[400px] transition-transform duration-300 ease-in-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          background: "#000",
          color: "#f5f5f5",
          fontFamily: RAJDHANI,
          borderLeft: "1px solid var(--border-gold)",
          boxShadow: open ? "var(--shadow-gold)" : "none",
        }}
        data-testid="panel-support-chat"
        aria-hidden={!open}
      >
        <div className="flex flex-col h-full">
          <div
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: "1px solid var(--border-gold)" }}
          >
            <h2
              className="text-2xl"
              style={{
                fontFamily: PLAYFAIR,
                color: "var(--gold-light)",
                letterSpacing: "0.02em",
              }}
              data-testid="text-support-chat-title"
            >
              AiPM Support
            </h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen(false)}
              aria-label="Close support chat"
              title="Close"
              data-testid="button-support-chat-close"
              style={{ color: "#e6d8a8" }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
            data-testid="container-support-chat-messages"
          >
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className="max-w-[85%] rounded-md px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words"
                  style={
                    m.role === "user"
                      ? {
                          background: "rgba(168,137,46,0.18)",
                          border: "1px solid var(--border-gold)",
                          color: "#f5f5f5",
                        }
                      : {
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.08)",
                          color: "#f5f5f5",
                        }
                  }
                  data-testid={`bubble-${m.role}-${m.id}`}
                >
                  {m.text}
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="flex justify-start" data-testid="indicator-typing">
                <div
                  className="rounded-md px-3 py-2 flex items-center gap-1.5"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <span
                    className="block w-1.5 h-1.5 rounded-full animate-pulse"
                    style={{
                      background: "var(--gold-light)",
                      animationDelay: "0ms",
                    }}
                  />
                  <span
                    className="block w-1.5 h-1.5 rounded-full animate-pulse"
                    style={{
                      background: "var(--gold-light)",
                      animationDelay: "200ms",
                    }}
                  />
                  <span
                    className="block w-1.5 h-1.5 rounded-full animate-pulse"
                    style={{
                      background: "var(--gold-light)",
                      animationDelay: "400ms",
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <form
            className="flex items-center gap-2 px-4 py-3"
            style={{ borderTop: "1px solid var(--border-gold)" }}
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Paste a screenshot (coming soon)"
              data-testid="button-support-chat-paperclip"
              onClick={handlePaperclipClick}
              style={{ color: "#C9A84C" }}
              className="shrink-0 h-11 w-11"
            >
              <Paperclip className="h-5 w-5" />
            </Button>
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onPaste={handlePaste}
              placeholder="Type your message..."
              className="flex-1 h-11 px-3 text-sm rounded-md outline-none placeholder:text-[#8A8A9A] focus:ring-2 focus:ring-[#C9A84C]/40"
              style={{
                background: "#1C1C22",
                border: "1px solid #C9A84C",
                color: "#E8E8EC",
                fontFamily: RAJDHANI,
              }}
              data-testid="input-support-chat-message"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!inputText.trim() || isTyping}
              data-testid="button-support-chat-send"
              className="shrink-0 h-11 w-11 disabled:opacity-100"
              style={{
                background: !inputText.trim() || isTyping
                  ? "linear-gradient(180deg, #8B6E2A, #5A4715)"
                  : "linear-gradient(180deg, #C9A84C, #8B6E2A)",
                color: "#000",
                border: "1px solid #8B6E2A",
              }}
            >
              <Send className="h-5 w-5" />
            </Button>
          </form>
        </div>
      </div>
      )}
    </>
  );
}
