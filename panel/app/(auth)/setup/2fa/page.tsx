import { redirect } from "next/navigation";
import { renderSVG } from "uqr";
import { AuthHeader } from "@/components/auth";
import { Setup2faForm } from "@/components/auth-forms";
import { CopyButton } from "@/components/form";
import { decrypt } from "@/lib/crypto";
import { getSetup } from "@/lib/setup";
import { otpauthUri } from "@/lib/totp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Two-factor" };

export default async function Setup2faPage() {
  const setup = await getSetup();
  if (!setup?.email || !setup.totpSecretEnc) redirect("/setup");
  const secret = decrypt(setup.totpSecretEnc);
  const svg = renderSVG(otpauthUri(secret, setup.email, "Self Host Layer"), { border: 1, ecc: "M" });
  const grouped = secret.match(/.{1,4}/g)!.join(" ");

  return (
    <>
      <AuthHeader step="Step 3 of 3" title="Turn on two-factor sign-in" description="Required. Scan this with 1Password, Authy, Google Authenticator or any TOTP app." />
      <div className="mb-6 grid gap-4">
        {/* Black-on-white in both themes, so every phone camera reads it. */}
        <div className="mx-auto size-44 rounded-lg border border-border bg-white p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-subtle py-1 pl-3 pr-1">
          <code className="min-w-0 truncate font-mono text-[12px] tracking-wide">{grouped}</code>
          <CopyButton text={secret} />
        </div>
        <p className="text-center text-[12px] text-muted">Can't scan? Enter the key above in your app by hand.</p>
      </div>
      <Setup2faForm />
    </>
  );
}
