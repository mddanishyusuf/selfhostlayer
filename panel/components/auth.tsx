export function AuthHeader({ step, title, description }: { step?: string; title: string; description?: React.ReactNode }) {
  return (
    <header className="mb-6 grid gap-1.5">
      {step && <p className="text-[12px] font-medium uppercase tracking-wider text-muted">{step}</p>}
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-muted">{description}</p>}
    </header>
  );
}
