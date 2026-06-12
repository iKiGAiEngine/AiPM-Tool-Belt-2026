import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChevronDown, Building2 } from "lucide-react";

interface EstimatingProject {
  id: number;
  projectName: string;
  estimateNumber: string;
}

interface ProjectNameComboBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputRef?: React.RefObject<HTMLInputElement>;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  "data-testid"?: string;
}

export default function ProjectNameComboBox({
  value,
  onChange,
  placeholder = "Select or type a project name",
  className,
  inputRef,
  onBlur,
  onKeyDown,
  "data-testid": testId,
}: ProjectNameComboBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const { data: projects = [] } = useQuery<EstimatingProject[]>({
    queryKey: ["/api/proposal-log/estimating-projects"],
  });

  const filtered = projects.filter((p) =>
    !value.trim() ||
    p.projectName.toLowerCase().includes(value.toLowerCase()) ||
    p.estimateNumber.toLowerCase().includes(value.toLowerCase())
  );

  useEffect(() => {
    setHighlightIndex(-1);
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const item = listRef.current.children[highlightIndex] as HTMLElement;
      if (item) item.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  const handleSelect = (project: EstimatingProject) => {
    onChange(project.projectName);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else {
        setHighlightIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && isOpen && highlightIndex >= 0 && filtered[highlightIndex]) {
      e.preventDefault();
      handleSelect(filtered[highlightIndex]);
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
    onKeyDown?.(e);
  };

  const handleBlur = () => {
    setTimeout(() => {
      if (containerRef.current && !containerRef.current.contains(document.activeElement)) {
        setIsOpen(false);
        onBlur?.();
      }
    }, 150);
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          data-testid={testId}
          className="pr-8"
        />
        <button
          type="button"
          tabIndex={-1}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setIsOpen(!isOpen)}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} />
        </button>
      </div>

      {isOpen && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover shadow-lg"
          data-testid={testId ? `${testId}-dropdown` : undefined}
        >
          {filtered.map((project, idx) => (
            <li
              key={project.id}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors",
                idx === highlightIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(project);
              }}
              onMouseEnter={() => setHighlightIndex(idx)}
              data-testid={testId ? `${testId}-option-${project.id}` : undefined}
            >
              <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="truncate flex-1">{project.projectName}</span>
              <span className="text-xs text-muted-foreground shrink-0 font-mono">
                {project.estimateNumber}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
