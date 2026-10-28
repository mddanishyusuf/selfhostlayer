import { redirect } from "next/navigation";
import { AuthHeader } from "@/components/auth";
import { SetupTokenForm } from "@/components/auth-forms";
import { hasAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up" };

export default function SetupPage() {
  if (hasAdmin()) redirect("/login");
  return (
    <>
      <AuthHeader step="Step 1 of 3" title="Set up Self Host Layer" description="Prove you installed this server by pasting the one-time setup token." />
      <SetupTokenForm />
    </>
  );
}
