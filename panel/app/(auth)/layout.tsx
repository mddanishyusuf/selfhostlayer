import { Logo } from "@/components/ui";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh grid-rows-[1fr_auto] bg-background px-4">
      <div className="flex flex-col items-center justify-center py-16">
        <div className="mb-8">
          <Logo />
        </div>
        <div className="w-full max-w-[400px] rounded-[20px] bg-card p-8">{children}</div>
      </div>
      <footer className="pb-6 text-center text-[13px] text-muted">Running on your own server. No Docker.</footer>
    </main>
  );
}
