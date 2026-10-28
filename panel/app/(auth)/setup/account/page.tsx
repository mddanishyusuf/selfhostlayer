import { redirect } from "next/navigation";
import { AuthHeader } from "@/components/auth";
import { AccountForm } from "@/components/auth-forms";
import { getSetup } from "@/lib/setup";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create admin" };

export default async function AccountPage() {
  if (!(await getSetup())) redirect("/setup");
  return (
    <>
      <AuthHeader step="Step 2 of 3" title="Create the admin account" description="This is the only account on the panel. You'll sign in with it." />
      <AccountForm />
    </>
  );
}
