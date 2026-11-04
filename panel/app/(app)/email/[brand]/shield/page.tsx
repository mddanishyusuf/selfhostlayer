import Link from "next/link";
import { CopyButton } from "@/components/form";
import { AbuseKeyForm, CleanList, RefreshLists, ShieldForm } from "@/components/email-shield";
import { when } from "@/components/email-ui";
import { KeyValues, Notice, PageHeader, SettingsRow } from "@/components/page";
import { brandFor, checkLabel, emailPublicUrl, listsOf, shieldOf, type ShieldInfo } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shield" };

const LIST_NAMES: Record<string, string> = {
  disposable: "Temporary email domains",
  toxicDomains: "StopForumSpam's spam domains",
  spamIps: "StopForumSpam's IPs (30 days)",
  torExits: "Tor exit nodes",
  datacenters: "Data-center ranges",
};

export default async function ShieldPage({ params }: { params: Promise<{ brand: string }> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let info: ShieldInfo;
  let firstList: { publicKey: string } | undefined;
  try {
    [info, firstList] = await Promise.all([shieldOf(project, brand.id), listsOf(project, brand.id).then((l) => l[0])]);
  } catch (err) {
    return (
      <>
        <PageHeader title={brand.name} crumb="Shield" />
        <Notice lead="Not reachable" tone="err">
          {(err as Error).message}
        </Notice>
      </>
    );
  }
  const base = emailPublicUrl(project);
  const snippet = `<form action="${base}/subscribe/${firstList?.publicKey ?? "LIST_KEY"}" method="post">\n  <input type="email" name="email" required>\n  <button>Subscribe</button>\n</form>\n<script src="${base}/subscribe.js" defer></script>`;
  const checks = Object.entries(info.stats.byCheck);
  return (
    <>
      <PageHeader title={brand.name} crumb="Shield" meta="Keeps bad and spam addresses off your lists" />
      {info.flagged > 0 && (
        <Notice lead="Flagged">
          {info.flagged.toLocaleString("en")} contact{info.flagged === 1 ? " is" : "s are"} waiting for you:{" "}
          <Link href={`/email/${brand.id}/contacts?status=flagged`} className="text-accent hover:underline">
            review them
          </Link>
          . Campaigns and automations skip them until you approve them.
        </Notice>
      )}
      <SettingsRow title="Last 30 days" description="Sign-ups, imports, syncs and API calls Shield refused or flagged. Only the check and where it came from are kept, never the address.">
        <KeyValues
          inset
          items={[
            ["Refused", info.stats.refused.toLocaleString("en")],
            ["Flagged", info.stats.flagged.toLocaleString("en")],
            ...(checks.length ? ([["By check", checks.map(([id, v]) => `${checkLabel(id)} ${(v!.refused + v!.flagged).toLocaleString("en")}`).join(" · ")]] as [string, string][]) : []),
            ...(Object.keys(info.stats.bySource).length ? ([["From", Object.entries(info.stats.bySource).map(([s, n]) => `${{ form: "sign-up forms", api: "the API", import: "imports", sync: "syncs" }[s] ?? s} ${n.toLocaleString("en")}`).join(" · ")]] as [string, string][]) : []),
          ]}
        />
      </SettingsRow>
      <SettingsRow title="Checks" description="What happens to an address that fails each one. The address checks run on every way in; the last three need a browser, so only sign-up forms get them.">
        <ShieldForm brandId={brand.id} checks={info.settings.checks} allowDatacenter={info.settings.allowDatacenter} />
      </SettingsRow>
      <SettingsRow title="Clean the list" description="Runs the address checks on every subscribed and unconfirmed contact you haven't approved, and shows what it found before anything changes.">
        <CleanList brandId={brand.id} scan={info.scan} />
      </SettingsRow>
      <SettingsRow title="The form snippet" description="Optional. On a sign-up form that posts here, it adds a hidden field bots fill in, how long the page was open, whether a script drives the browser, and the visitor's time zone.">
        <div className="grid gap-2">
          <pre className="overflow-x-auto whitespace-pre bg-code px-3.5 py-3 font-mono text-[12px] leading-relaxed text-[#e5e5ea]">{snippet}</pre>
          <div>
            <CopyButton text={snippet} />
          </div>
        </div>
      </SettingsRow>
      <SettingsRow title="AbuseIPDB" description="Optional, for every brand here. With a free key (1,000 lookups a day) sign-ups from IPs reported for abuse count as abusive. Only sign-up IPs are sent to AbuseIPDB, never addresses.">
        <AbuseKeyForm has={info.abuseipdb} />
      </SettingsRow>
      <SettingsRow title="Lists" description="Downloaded by this server and kept in its data folder: a failed download keeps the last copy. Temporary domains and data centers are refreshed weekly, the rest daily.">
        <div className="grid gap-3">
          <KeyValues
            inset
            items={info.lists.map((l) => [
              LIST_NAMES[l.name] ?? l.name,
              <span key={l.name} className={l.error ? "text-err" : l.updatedAt ? "" : "text-warn"}>
                {l.updatedAt ? `${l.entries.toLocaleString("en")} entries, ${when(l.updatedAt)}` : "Not downloaded yet"}
                {l.error && ` · last try failed: ${l.error}`}
              </span>,
            ])}
          />
          <RefreshLists />
        </div>
      </SettingsRow>
    </>
  );
}
