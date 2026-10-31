// What Forms' pages share: a form's status as a pill, durations, and an
// answer as it reads in a response (choices as a list, files to download).
import { PaperclipIcon } from "lucide-react";
import { answerText, type Field } from "@/lib/form-schema";
import type { Form, FormResponse } from "@/lib/forms";
import { Icon } from "./icon";
import { cx } from "./ui";

/** Open (green), closed by hand (gray), or closed by its time or its limit (gold). */
export function FormStatus({ form, closed }: { form: Pick<Form, "status">; closed: string | null | undefined }) {
  const [label, tone] = !closed ? ["Open", "border-ok-line text-ok"] : form.status === "closed" ? ["Closed", "border-transparent bg-pill text-pill-text"] : closed === "full" ? ["Full", "border-transparent bg-warn-soft text-warn"] : ["Ended", "border-transparent bg-warn-soft text-warn"];
  return (
    <span className={cx("inline-flex items-center whitespace-nowrap border px-[7px] py-px text-[11px]", tone)} title={closed ? `Not taking answers: ${closed}` : "Taking answers"} data-testid="form-status">
      {label}
    </span>
  );
}

/** 42s, 3m 10s, 1h 5m. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** One answer, whole: lists stay lists, ratings show their stars, files link to the panel's download. */
export function Answer({ field, response, fileHref }: { field: Field; response: FormResponse; fileHref: (file: string) => string }) {
  const a = response.answers[field.id];
  if (field.type === "file") {
    const files = response.files.filter((f) => f.fieldId === field.id);
    if (!files.length) return <span className="text-dim">No answer</span>;
    return (
      <span className="grid gap-1">
        {files.map((f) => (
          <a key={f.id} href={fileHref(f.id)} className="inline-flex items-center gap-1.5 text-accent hover:underline" data-testid="response-file">
            <Icon icon={PaperclipIcon} size={13} /> {f.name} <span className="text-[12px] text-dim">{(f.size / 1024).toFixed(f.size < 10_240 ? 1 : 0)} KB</span>
          </a>
        ))}
      </span>
    );
  }
  if (a === undefined || a === null || a === "" || (Array.isArray(a) && !a.length)) return <span className="text-dim">No answer</span>;
  if (Array.isArray(a)) {
    return (
      <span className="flex flex-wrap gap-1">
        {a.map((v) => (
          <span key={String(v)} className="border border-border px-[7px] py-px text-[12px]">
            {String(v)}
          </span>
        ))}
      </span>
    );
  }
  if (field.type === "rating") return <span title={`${a} of ${field.max ?? 5}`}>{"★".repeat(Number(a))}<span className="text-dim">{"★".repeat(Math.max(0, (field.max ?? 5) - Number(a)))}</span></span>;
  if (field.type === "yes_no") return <span>{a === "yes" ? "Yes" : a === "no" ? "No" : String(a)}</span>;
  if (field.type === "url" && /^https?:\/\//.test(String(a))) {
    return (
      <a href={String(a)} target="_blank" rel="noreferrer nofollow" className="break-all text-accent hover:underline">
        {String(a)}
      </a>
    );
  }
  if (field.type === "email") {
    return (
      <a href={`mailto:${String(a)}`} className="break-all text-accent hover:underline">
        {String(a)}
      </a>
    );
  }
  return <span className="whitespace-pre-wrap break-words">{answerText(a)}</span>;
}
