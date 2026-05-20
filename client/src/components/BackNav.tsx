import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

interface BackNavProps {
  href: string;
  label: string;
  testId?: string;
  disabled?: boolean;
}

export function BackNav({ href, label, testId, disabled }: BackNavProps) {
  return (
    <Link href={href}>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        data-testid={testId ?? "button-back"}
        className="gap-1.5 font-medium"
        style={{ color: "var(--text-dim)" }}
      >
        <ArrowLeft className="w-3.5 h-3.5 flex-shrink-0" />
        {label}
      </Button>
    </Link>
  );
}
