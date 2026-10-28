"use client";

import { flushSync, useFormStatus } from "react-dom";
import { useRef, useState } from "react";
import { Button, cx } from "./ui";

export function SubmitButton({ children, pending: pendingLabel, className }: { children: React.ReactNode; pending: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={cx("w-full", className)}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

/** Six boxes for a 2FA code. Typing advances, Backspace goes back, pasting fills all. */
export function CodeInput({ name = "code", autoFocus = true }: { name?: string; autoFocus?: boolean }) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const fill = (start: number, text: string) => {
    const clean = text.replace(/\D/g, "").slice(0, 6 - start);
    if (!clean) return;
    const next = [...digits];
    [...clean].forEach((d, i) => (next[start + i] = d));
    // Render now, so the hidden input holds the full code before auto-submit.
    flushSync(() => setDigits(next));
    const target = Math.min(start + clean.length, 5);
    refs.current[target]?.focus();
    if (next.every(Boolean)) refs.current[target]?.form?.requestSubmit();
  };

  return (
    <div className="flex justify-between gap-2" onPaste={(e) => (e.preventDefault(), fill(0, e.clipboardData.getData("text")))}>
      <input type="hidden" name={name} value={digits.join("")} />
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          autoFocus={autoFocus && i === 0}
          aria-label={`Digit ${i + 1}`}
          // No maxLength: autofill and paste insert the whole code into one
          // box, and fill() spreads it across all six.
          onChange={(e) => {
            if (e.target.value === "") {
              const next = [...digits];
              next[i] = "";
              setDigits(next);
            } else fill(i, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
            if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
            if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
          }}
          className="h-12 w-full min-w-0 rounded-md border border-border bg-background text-center font-mono text-lg tabular-nums transition-colors duration-150 outline-none hover:border-border-strong focus:border-muted focus-visible:ring-2 focus-visible:ring-accent/50"
        />
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded px-2 py-1 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
