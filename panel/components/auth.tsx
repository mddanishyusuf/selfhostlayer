export function AuthHeader({ step, title, description }: { step?: string; title: string; description?: React.ReactNode }) {
  return (
    <header className="mb-6 grid gap-1.5">
      {step && <p className="text-[12px] text-muted">{step}</p>}
      <h1 className="text-[24px] font-bold">{title}</h1>
      {description && <p className="text-muted">{description}</p>}
    </header>
  );
}
