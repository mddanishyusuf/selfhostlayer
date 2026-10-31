export function AuthHeader({ step, title, description }: { step?: string; title: string; description?: React.ReactNode }) {
  return (
    <header className="mb-6 grid gap-1.5">
      {step && <p className="text-[12.5px] font-medium text-lavender">{step}</p>}
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
      {description && <p className="text-muted">{description}</p>}
    </header>
  );
}
