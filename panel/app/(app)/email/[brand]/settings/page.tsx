import { BrandForm, DeleteBrand, ProviderForm, ProviderTools, SendingForm, SesEventsButton } from "@/components/email-forms";
import { PageHeader, SettingsRow } from "@/components/page";
import { brandFor, emailPublicUrl } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brand settings" };

export default async function BrandSettingsPage({ params }: { params: Promise<{ brand: string }> }) {
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  return (
    <>
      <PageHeader title={brand.name} crumb="Settings" meta="Who it sends as, and how" />
      <SettingsRow title="Brand" description="The defaults campaigns and automations start from.">
        <BrandForm brand={brand} />
      </SettingsRow>
      <SettingsRow id="provider" title="Provider" description="What sends the mail: any SMTP server, or Amazon SES through its API.">
        <ProviderForm brand={brand} />
        {brand.provider !== "none" && <ProviderTools brand={brand} />}
      </SettingsRow>
      {brand.provider === "ses" && (
        <SettingsRow title="Bounces and complaints" description="SES tells this server about each bounce, complaint and delivery, through an SNS topic it sets up for you.">
          <p className="text-[13px]">{brand.ses?.events ? `Set up: configuration set ${brand.ses.events.configurationSet}, sending to ${emailPublicUrl(project)}/webhooks/ses.` : "Not set up yet: bounces and complaints from SES aren't seen, so bad addresses stay on your lists."}</p>
          <SesEventsButton brandId={brand.id} ready={!!brand.ses?.events} />
        </SettingsRow>
      )}
      <SettingsRow title="Sending" description="How fast, and what's counted.">
        <SendingForm brand={brand} />
      </SettingsRow>
      <SettingsRow title="Delete the brand" description="Everything in it goes: contacts, campaigns, logs.">
        <div>
          <DeleteBrand brand={brand} />
        </div>
      </SettingsRow>
    </>
  );
}
