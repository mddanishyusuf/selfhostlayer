import { redirect } from "next/navigation";
import { AuthHeader } from "@/components/auth";
import { Login2faForm } from "@/components/auth-forms";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Two-factor" };

export default async function Login2faPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.mfaOk) redirect("/");
  return (
    <>
      <AuthHeader title="Two-factor sign-in" description={<>Signing in as <span className="text-foreground">{session.user.email}</span></>} />
      <Login2faForm />
    </>
  );
}
