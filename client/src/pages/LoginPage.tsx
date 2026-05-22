import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Link } from "wouter";

function AnimatedCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    var w: number, h: number;
    function resize() { w = canvas!.width = window.innerWidth; h = canvas!.height = window.innerHeight; }
    window.addEventListener("resize", resize); resize();

    var blobs: any[] = [];
    var blobColors = [
      { r: 220, g: 180, b: 80 }, { r: 200, g: 164, b: 78 }, { r: 180, g: 150, b: 70 },
      { r: 160, g: 140, b: 65 }, { r: 210, g: 175, b: 90 }, { r: 140, g: 125, b: 60 },
      { r: 190, g: 160, b: 80 }, { r: 230, g: 190, b: 95 }
    ];
    for (var i = 0; i < 8; i++) {
      blobs.push({
        x: Math.random() * 2000 - 200, y: Math.random() * 1200 - 100,
        vx: (Math.random() - .5) * .45, vy: (Math.random() - .5) * .45,
        radius: Math.random() * 320 + 200,
        color: blobColors[i],
        opacity: Math.random() * .18 + .1,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * .002 + .001
      });
    }

    var particles: any[] = [];
    for (var i = 0; i < 50; i++) {
      particles.push({
        x: Math.random() * 2000, y: Math.random() * 1200,
        vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25,
        size: Math.random() * 2.5 + .8,
        opacity: Math.random() * .45 + .15,
        pulse: Math.random() * Math.PI * 2
      });
    }

    var beams = [
      { x: 0, y: 0, angle: 0.4, width: 400, speed: .0003, offset: 0 },
      { x: 0, y: 0, angle: -0.3, width: 300, speed: .0002, offset: 2 },
      { x: 0, y: 0, angle: 0.7, width: 350, speed: .00025, offset: 4 },
      { x: 0, y: 0, angle: 1.1, width: 280, speed: .00018, offset: 5.5 }
    ];

    var t = 0;

    function drawGrid() {
      ctx!.strokeStyle = "rgba(200,164,78,.04)";
      ctx!.lineWidth = 1;
      var size = 80;
      for (var x = 0; x < w; x += size) { ctx!.beginPath(); ctx!.moveTo(x, 0); ctx!.lineTo(x, h); ctx!.stroke(); }
      for (var y = 0; y < h; y += size) { ctx!.beginPath(); ctx!.moveTo(0, y); ctx!.lineTo(w, y); ctx!.stroke(); }
    }

    function drawBlob(b: any) {
      var pulse = 1 + Math.sin(t * b.speed * 60 + b.phase) * .12;
      var r = b.radius * pulse;
      var grad = ctx!.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
      grad.addColorStop(0, "rgba(" + b.color.r + "," + b.color.g + "," + b.color.b + "," + (b.opacity * 2.5) + ")");
      grad.addColorStop(.5, "rgba(" + b.color.r + "," + b.color.g + "," + b.color.b + "," + (b.opacity * 1.4) + ")");
      grad.addColorStop(1, "rgba(" + b.color.r + "," + b.color.g + "," + b.color.b + ",0)");
      ctx!.fillStyle = grad;
      ctx!.beginPath();
      var pts = 7;
      for (var i = 0; i <= pts; i++) {
        var a = (i / pts) * Math.PI * 2;
        var wobble = Math.sin(t * b.speed * 35 + a * 2.5 + b.phase) * .18 + 1;
        var px = b.x + Math.cos(a) * r * wobble;
        var py = b.y + Math.sin(a) * r * wobble;
        if (i === 0) ctx!.moveTo(px, py);
        else {
          var ca = ((i - .5) / pts) * Math.PI * 2;
          var cw = Math.sin(t * b.speed * 35 + ca * 2.5 + b.phase + 1) * .18 + 1;
          ctx!.quadraticCurveTo(b.x + Math.cos(ca) * r * cw * 1.1, b.y + Math.sin(ca) * r * cw * 1.1, px, py);
        }
      }
      ctx!.closePath(); ctx!.fill();
    }

    function drawBeams() {
      for (var i = 0; i < beams.length; i++) {
        var bm = beams[i];
        var sweep = Math.sin(t * bm.speed * 60 + bm.offset) * w * .6 + w * .5;
        var grad = ctx!.createLinearGradient(sweep - bm.width, 0, sweep + bm.width, 0);
        grad.addColorStop(0, "rgba(200,164,78,0)");
        grad.addColorStop(.5, "rgba(200,164,78,.09)");
        grad.addColorStop(1, "rgba(200,164,78,0)");
        ctx!.save();
        ctx!.translate(w / 2, h / 2);
        ctx!.rotate(bm.angle + Math.sin(t * .0005) * 0.05);
        ctx!.translate(-w / 2, -h / 2);
        ctx!.fillStyle = grad;
        ctx!.fillRect(0, 0, w, h);
        ctx!.restore();
      }
    }

    function drawConnections() {
      ctx!.lineWidth = .5;
      for (var i = 0; i < particles.length; i++) {
        for (var j = i + 1; j < particles.length; j++) {
          var dx = particles[i].x - particles[j].x;
          var dy = particles[i].y - particles[j].y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 140) {
            ctx!.strokeStyle = "rgba(200,164,78," + (1 - dist / 140) * .15 + ")";
            ctx!.beginPath(); ctx!.moveTo(particles[i].x, particles[i].y); ctx!.lineTo(particles[j].x, particles[j].y); ctx!.stroke();
          }
        }
      }
    }

    var animId: number;
    function animate() {
      t += .016;
      ctx!.clearRect(0, 0, w, h);
      ctx!.fillStyle = "#0C0E14"; ctx!.fillRect(0, 0, w, h);
      drawGrid();
      drawBeams();
      for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        b.x += b.vx; b.y += b.vy;
        if (b.x < -200) b.vx = Math.abs(b.vx); if (b.x > w + 200) b.vx = -Math.abs(b.vx);
        if (b.y < -200) b.vy = Math.abs(b.vy); if (b.y > h + 200) b.vy = -Math.abs(b.vy);
        drawBlob(b);
      }
      drawConnections();
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0; if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        var po = p.opacity * (1 + Math.sin(t * 2 + p.pulse) * .4);
        ctx!.fillStyle = "rgba(200,164,78," + po + ")";
        ctx!.beginPath(); ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx!.fill();
      }
      animId = requestAnimationFrame(animate);
    }
    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: 0 }}
    />
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const loginMutation = useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: () => {
      setSuccess(true);
      setError("");
      queryClient.removeQueries({ queryKey: ["/api/user/features"] });
      // Reduced from 800ms — the session cookie is set synchronously with the
      // login response so we only need a brief moment for the state to settle.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      }, 150);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError("");
    loginMutation.mutate({ email: email.trim(), password });
  }, [email, password, loginMutation]);

  const inputStyles: React.CSSProperties = {
    width: "100%",
    padding: "0.7rem 0.85rem",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "10px",
    color: "#F0F0F2",
    fontSize: "0.88rem",
    fontFamily: "'DM Sans', sans-serif",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
  };

  const goldBtnStyles: React.CSSProperties = {
    width: "100%",
    padding: "0.75rem",
    background: "linear-gradient(135deg, var(--gold), var(--gold-dim))",
    border: "1px solid rgba(201,168,76,0.3)",
    borderRadius: "10px",
    color: "var(--bg)",
    fontSize: "0.88rem",
    fontWeight: 700,
    fontFamily: "'Rajdhani', sans-serif",
    textTransform: "uppercase" as const,
    letterSpacing: "1px",
    cursor: "pointer",
    transition: "all 0.2s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=DM+Sans:wght@300;400;500&display=swap');
        .login-page-root * { box-sizing: border-box; }
        .login-card::before {
          content: "";
          position: absolute;
          top: 0; left: 10%; right: 10%;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(200,164,78,0.3), transparent);
        }
        .login-input:focus {
          border-color: #C8A44E !important;
          box-shadow: 0 0 0 3px rgba(200,164,78,0.1) !important;
        }
        .gold-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
        .gold-btn:active { transform: translateY(0); }
        .gold-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; filter: none; }
        .link-btn {
          background: none;
          border: none;
          color: #8A8F9E;
          font-size: 0.8rem;
          cursor: pointer;
          font-family: 'DM Sans', sans-serif;
          padding: 0.25rem 0;
          transition: color 0.2s;
          text-decoration: none;
        }
        .link-btn:hover { color: #C8A44E; }
        .spinner {
          width: 16px; height: 16px;
          border: 2.5px solid rgba(10,12,16,0.3);
          border-top-color: #0A0C10;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: scale(1); } }
        .step-animate { animation: fadeIn 0.35s ease-out; }
        .success-animate { animation: scaleIn 0.5s ease-out; }
        .pw-toggle {
          position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer; color: #5C6170; padding: 0.2rem;
          transition: color 0.2s;
        }
        .pw-toggle:hover { color: #C8A44E; }
      `}</style>
      <div className="login-page-root" style={{ fontFamily: "'DM Sans', sans-serif", background: "var(--bg)", minHeight: "100vh", overflow: "hidden" }}>
        <AnimatedCanvas />

        <div style={{ position: "relative", zIndex: 10, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div
            className="login-card"
            style={{
              width: "100%",
              maxWidth: "420px",
              background: "rgba(10,13,20,0.96)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
              border: "1px solid rgba(200,164,78,0.12)",
              borderRadius: "20px",
              padding: "2.25rem 2rem 1.75rem",
              boxShadow: "0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04), 0 0 60px rgba(200,164,78,0.08)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.85rem", marginBottom: "2rem", paddingTop: "0.25rem" }}>
              <div style={{
                width: "48px", height: "48px",
                clipPath: "polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)",
                background: "linear-gradient(135deg, var(--gold), var(--gold-dim))",
                boxShadow: "0 4px 16px rgba(201,168,76,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0A0C10" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: "1.65rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
                <span style={{ background: "linear-gradient(135deg, var(--gold-light), var(--gold))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>AiPM</span>
                <span
                  style={{ color: "var(--text)" }}
                  className="opacity-[1] border-t-[#dcdce0] border-r-[#dcdce0] border-b-[#dcdce0] border-l-[#dcdce0] bg-[transparent] text-[#717196]"> Tool Belt</span>
              </span>
            </div>

            {success ? (
              <div className="success-animate" style={{ textAlign: "center", padding: "1rem 0" }}>
                <div style={{ width: "60px", height: "60px", borderRadius: "50%", background: "rgba(200,164,78,0.12)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1rem" }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#C8A44E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                <h2 style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: "1.4rem", fontWeight: 700, color: "var(--text)", margin: "0 0 0.5rem" }}>Signed in!</h2>
                <p style={{ color: "#8A8F9E", fontSize: "0.85rem" }}>Loading your workspace…</p>
              </div>
            ) : (
              <div className="step-animate">
                <h2 style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: "1.55rem", fontWeight: 700, color: "#FFFFFF", margin: "0 0 0.3rem", textAlign: "center" }}>Sign in</h2>
                <p style={{ fontSize: "0.82rem", color: "#B8BCC8", margin: "0 0 1.5rem", textAlign: "center" }}>Access is by authorized invite only. Contact your administrator for access.</p>

                <form onSubmit={handleSubmit}>
                  <div style={{ marginBottom: "1rem" }}>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, color: "#B8BCC8", marginBottom: "0.4rem" }}>Email</label>
                    <input
                      className="login-input"
                      type="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      style={inputStyles}
                      required
                      autoFocus
                      autoComplete="username"
                      data-testid="input-email"
                    />
                  </div>

                  <div style={{ marginBottom: "0.5rem" }}>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 500, color: "#B8BCC8", marginBottom: "0.4rem" }}>Password</label>
                    <div style={{ position: "relative" }}>
                      <input
                        className="login-input"
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        style={{ ...inputStyles, paddingRight: "2.5rem" }}
                        required
                        autoComplete="current-password"
                        data-testid="input-password"
                      />
                      <button
                        type="button"
                        className="pw-toggle"
                        onClick={() => setShowPassword(p => !p)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                            <line x1="1" y1="1" x2="23" y2="23"/>
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  <div style={{ textAlign: "right", marginBottom: "1.25rem" }}>
                    <Link href="/forgot-password" className="link-btn" style={{ fontSize: "0.78rem" }} data-testid="link-forgot-password">
                      Forgot password?
                    </Link>
                  </div>

                  {error && (
                    <p style={{ color: "#ef4444", fontSize: "0.82rem", marginBottom: "0.75rem", textAlign: "left" }} data-testid="text-error">{error}</p>
                  )}

                  <button
                    className="gold-btn"
                    type="submit"
                    disabled={loginMutation.isPending || !email.trim() || !password}
                    style={goldBtnStyles}
                    data-testid="button-sign-in"
                  >
                    {loginMutation.isPending ? <div className="spinner"></div> : "Sign In"}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
