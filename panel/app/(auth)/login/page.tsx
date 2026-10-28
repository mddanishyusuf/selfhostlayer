import { redirect } from "next/navigation";
import { AuthHeader } from "@/components/auth";
import { LoginForm } from "@/components/auth-forms";
import { getSession, hasAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (!hasAdmin()) redirect("/setup");
  const session = await getSession();
  if (session?.mfaOk) redirect("/");
  return (
    <>
      <AuthHeader title="Sign in" />
      <LoginForm />
    </>
  );
}
