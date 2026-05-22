import { useState } from "react";

export function OptionB() {
  const [showPw, setShowPw] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=DM+Sans:wght@300;400;500&display=swap');
        .opt-b * { box-sizing: border-box; }
        .opt-b-card::before {
          content: "";
          position: absolute;
          top: 0; left: 10%; right: 10%;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(200,164,78,0.3), transparent);
        }
        .opt-b-input {
          width: 100%;
          padding: 0.7rem 0.85rem;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          color: #F0F0F2;
          font-size: 0.88rem;
          font-family: 'DM Sans', sans-serif;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .opt-b-input:focus {
          border-color: #C8A44E !important;
          box-shadow: 0 0 0 3px rgba(200,164,78,0.1) !important;
        }
        .opt-b-input::placeholder { color: #4A4F60; }
        .opt-b-btn {
          width: 100%;
          padding: 0.75rem;
          background: linear-gradient(135deg, #C8A44E, #9E7F3A);
          border: 1px solid rgba(201,168,76,0.3);
          border-radius: 10px;
          color: #0A0C10;
          font-size: 0.88rem;
          font-weight: 700;
          font-family: 'Rajdhani', sans-serif;
          text-transform: uppercase;
          letter-spacing: 1px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .opt-b-btn:hover { filter: brightness(1.1); }
        .opt-b-tag {
          position: absolute;
          top: -28px; left: 50%; transform: translateX(-50%);
          background: rgba(200,164,78,0.15);
          border: 1px solid rgba(200,164,78,0.3);
          color: #C8A44E;
          font-family: 'DM Sans', sans-serif;
          font-size: 0.7rem;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 3px 10px;
          border-radius: 20px;
          white-space: nowrap;
        }
        .pw-toggle-b {
          position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer; color: #5C6170; padding: 0.2rem;
        }
      `}</style>

      <div className="opt-b" style={{
        fontFamily: "'DM Sans', sans-serif",
        minHeight: "100vh",
        background: "#0C0E14",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Simulated blobs — same as current */}
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
          <div style={{ position: "absolute", top: "10%", left: "15%", width: 420, height: 420, borderRadius: "50%", background: "radial-gradient(circle, rgba(220,180,80,0.22) 0%, rgba(220,180,80,0.08) 50%, transparent 70%)", filter: "blur(30px)" }} />
          <div style={{ position: "absolute", bottom: "15%", right: "10%", width: 380, height: 380, borderRadius: "50%", background: "radial-gradient(circle, rgba(200,164,78,0.18) 0%, rgba(200,164,78,0.06) 50%, transparent 70%)", filter: "blur(30px)" }} />
          <div style={{ position: "absolute", top: "55%", left: "50%", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(180,150,70,0.15) 0%, transparent 70%)", filter: "blur(25px)" }} />
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.04 }}>
            <defs><pattern id="grid-b" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M 80 0 L 0 0 0 80" fill="none" stroke="rgba(200,164,78,1)" strokeWidth="1"/></pattern></defs>
            <rect width="100%" height="100%" fill="url(#grid-b)"/>
          </svg>
        </div>

        <div style={{ position: "relative", zIndex: 10, width: "100%", maxWidth: 420 }}>
          <div style={{ position: "relative" }}>
            <span className="opt-b-tag">Option B — Text + Solid Card</span>
          </div>

          <div
            className="opt-b-card"
            style={{
              /* OPTION B CHANGE: nearly opaque card */
              background: "rgba(10,13,20,0.96)",
              backdropFilter: "blur(40px)",
              border: "1px solid rgba(200,164,78,0.12)",
              borderRadius: 20,
              padding: "2.25rem 2rem 1.75rem",
              boxShadow: "0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04), 0 0 60px rgba(200,164,78,0.08)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {/* Logo row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.85rem", marginBottom: "2rem" }}>
              <div style={{
                width: 48, height: 48,
                clipPath: "polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)",
                background: "linear-gradient(135deg, #C8A44E, #9E7F3A)",
                boxShadow: "0 4px 16px rgba(201,168,76,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0A0C10" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: "1.65rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
                <span style={{ background: "linear-gradient(135deg, #E0C070, #C8A44E)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>AiPM</span>
                {/* OPTION B: "Tool Belt" still mid-gray — no change yet */}
                <span style={{ color: "#9A9FAE" }}> Tool Belt</span>
              </span>
            </div>

            {/* OPTION B CHANGE: heading → white, labels/subtitle → #B8BCC8 */}
            <h2 style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: "1.55rem", fontWeight: 700, color: "#FFFFFF", margin: "0 0 0.3rem", textAlign: "center" }}>Sign in</h2>
            <p style={{ fontSize: "0.82rem", color: "#B8BCC8", margin: "0 0 1.5rem", textAlign: "center" }}>Access is by authorized invite only. Contact your administrator for access.</p>

            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, color: "#B8BCC8", marginBottom: "0.4rem" }}>Email</label>
              <input className="opt-b-input" type="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>

            <div style={{ marginBottom: "0.5rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, color: "#B8BCC8", marginBottom: "0.4rem" }}>Password</label>
              <div style={{ position: "relative" }}>
                <input className="opt-b-input" type={showPw ? "text" : "password"} placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} style={{ paddingRight: "2.5rem" }} />
                <button type="button" className="pw-toggle-b" onClick={() => setShowPw(p => !p)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
              </div>
            </div>

            <div style={{ textAlign: "right", marginBottom: "1.25rem" }}>
              <a href="#" style={{ color: "#8A8F9E", fontSize: "0.78rem", textDecoration: "none", fontFamily: "'DM Sans', sans-serif" }}>Forgot password?</a>
            </div>

            <button className="opt-b-btn">Sign In</button>
          </div>

          {/* Change summary */}
          <div style={{ marginTop: 16, background: "rgba(200,164,78,0.06)", border: "1px solid rgba(200,164,78,0.15)", borderRadius: 10, padding: "0.75rem 1rem", fontSize: "0.75rem", color: "#9A9FAE", fontFamily: "'DM Sans', sans-serif" }}>
            <span style={{ color: "#C8A44E", fontWeight: 600 }}>Changes: </span>
            A changes + card opacity <span style={{ color: "#fff" }}>0.88 → 0.96</span> (blobs blocked out)
          </div>
        </div>
      </div>
    </>
  );
}
