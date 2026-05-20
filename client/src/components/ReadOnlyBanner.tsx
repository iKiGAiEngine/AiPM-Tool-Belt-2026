import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/lib/auth";

let _globalMounted = false;

export function ReadOnlyBanner({ global: isGlobal = false }: { global?: boolean }) {
  const { isViewer } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState({ x: 12, y: 60 });
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    if (isGlobal) {
      _globalMounted = true;
      setShouldRender(true);
      return () => { _globalMounted = false; };
    } else {
      if (!_globalMounted) {
        setShouldRender(true);
      }
    }
  }, [isGlobal]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y });
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!isViewer || !shouldRender) return null;

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      data-testid="banner-read-only"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[100] flex items-center gap-1.5 bg-amber-500/95 border border-amber-600 text-amber-950 text-xs font-medium rounded-md shadow-lg select-none"
    >
      <div
        onMouseDown={onMouseDown}
        className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-grab active:cursor-grabbing"
        title="Drag to move"
      >
        <span>⚠</span>
        {!collapsed && <span>Read-only access — changes cannot be saved.</span>}
      </div>
      <button
        onClick={() => setCollapsed(c => !c)}
        className="pr-2 py-1.5 text-amber-800 hover:text-amber-950 transition-colors"
        title={collapsed ? "Expand" : "Collapse"}
      >
        {collapsed ? "›" : "‹"}
      </button>
    </div>
  );
}
