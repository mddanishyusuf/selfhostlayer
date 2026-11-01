import { ListActions, NewListButton } from "@/components/email-forms";
import { CopyButton } from "@/components/form";
import { CARD, Empty, Notice, PageHeader, Section } from "@/components/page";
import { Pill } from "@/components/ui";
import { brandFor, emailPublicUrl, listsOf, type List } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lists" };

const signupForm = (url: string) => `<form action="${url}" method="post">
  <input type="email" name="email" placeholder="you@example.com" required>
  <input type="text" name="name" placeholder="Your name">
  <input type="text" name="_hp" style="display:none" tabindex="-1" autocomplete="off">
  <input type="hidden" name="redirect" value="https://example.com/thanks">
  <button type="submit">Subscribe</button>
</form>`;

export default async function ListsPage({ params }: { params: Promise<{ brand: string }> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let lists: List[] = [];
  let problem: string | null = null;
  try {
    lists = await listsOf(project, brand.id);
  } catch (err) {
    problem = (err as Error).message;
  }
  const base = emailPublicUrl(project);
  return (
    <>
      <PageHeader title={brand.name} crumb="Lists" meta="Groups of contacts campaigns and automations go to" actions={<NewListButton brandId={brand.id} />} />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <section className={CARD} data-testid="lists">
        {lists.length === 0 && !problem && <Empty>No lists yet: New list makes the first.</Empty>}
        {lists.map((l) => (
          <div key={l.id} className="grid gap-2 border-b border-border-soft px-3.5 py-3 last:border-b-0" data-testid="list-row">
            <div className="flex flex-wrap items-center gap-2">
              <b className="font-bold">{l.name}</b>
              {l.doubleOptIn && <Pill outline>Double opt-in</Pill>}
              <span className="text-[12px] text-muted">
                {l.subscribed.toLocaleString("en")} subscribed of {l.total.toLocaleString("en")}
              </span>
              <span className="ml-auto">
                <ListActions brandId={brand.id} list={l} />
              </span>
            </div>
            {l.description && <p className="text-[12px] text-muted">{l.description}</p>}
            <div className="flex items-center gap-2 bg-well px-3 py-2 text-[12px]">
              <span className="text-muted">Signup form posts to</span>
              <code className="min-w-0 flex-1 truncate font-mono">{`${base}/subscribe/${l.publicKey}`}</code>
              <CopyButton text={`${base}/subscribe/${l.publicKey}`} />
            </div>
          </div>
        ))}
      </section>
      {lists.length > 0 && (
        <Section title="A signup form" description="Paste it into your site; email is required, name and any other field are kept on the contact. The hidden _hp field keeps bots out.">
          <div className="border-t border-border p-3.5">
            <div className="flex items-start gap-2 bg-well px-3 py-2.5">
              <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-relaxed">{signupForm(`${base}/subscribe/${lists[0]!.publicKey}`)}</pre>
              <CopyButton text={signupForm(`${base}/subscribe/${lists[0]!.publicKey}`)} />
            </div>
            <p className="mt-2 text-[12px] text-muted">Sent with fetch and Accept: application/json, it answers {"{ ok, status }"} instead of a page.</p>
          </div>
        </Section>
      )}
    </>
  );
}
