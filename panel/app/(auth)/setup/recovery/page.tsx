import { Download } from "lucide-react";
import { redirect } from "next/navigation";
import { finishSetup, readRecoveryFlash } from "@/app/actions/auth";
import { AuthHeader } from "@/components/auth";
import { CopyButton, SubmitButton } from "@/components/form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recovery codes" };

export default async function RecoveryPage() {
  const codes = await readRecoveryFlash();
  if (!codes) redirect("/");
  const file = `Self Host Layer recovery codes\nEach code works once if you lose your authenticator app.\n\n${codes.join("\n")}\n`;

  return (
    <>
      <AuthHeader title="Save your recovery codes" description="If you lose your phone, each code signs you in once. This is the only time they're shown." />
      <div className="mb-4 rounded-md border border-border bg-subtle p-4">
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[13px] tabular-nums">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </div>
      <div className="mb-6 flex items-center justify-between">
        <a
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(file)}`}
          download="self-host-layer-recovery-codes.txt"
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
        >
          <Download className="size-3.5" aria-hidden /> Download .txt
        </a>
        <CopyButton text={codes.join("\n")} label="Copy all" />
      </div>
      <form action={finishSetup}>
        <SubmitButton pending="Opening…">I saved them, open the dashboard</SubmitButton>
      </form>
    </>
  );
}
