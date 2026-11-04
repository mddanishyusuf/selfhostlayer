// Shield's checks as the panel shows them: here, not in lib/email.ts, so client components can use them.

/** Shield's eight checks (catalog/email/src/shield.ts), in the order the panel shows them. */
export const SHIELD_CHECKS = [
  { id: "invalid", label: "Invalid email", about: "Malformed addresses, and domains with no mail server.", address: true },
  { id: "disposable", label: "Temporary email", about: "Disposable and throwaway inbox domains.", address: true },
  { id: "spamDomain", label: "Spam-listed domain", about: "Email domains listed by StopForumSpam.", address: true },
  { id: "freeMail", label: "Free webmail", about: "Gmail, Outlook and the like: for B2B sign-ups that should use a work address.", address: true },
  { id: "bounced", label: "Bounced elsewhere", about: "Addresses that hard-bounced or complained with another brand on this server.", address: true },
  { id: "scripted", label: "Scripted browsers", about: "Headless browsers, curl and scripts, the hidden field filled in, and forms sent faster than a person types.", address: false },
  { id: "spamIp", label: "Spam-listed IP", about: "IPs StopForumSpam saw spamming in the last 30 days.", address: false },
  { id: "abusiveIp", label: "Abusive IPs", about: "Tor exit nodes and data centers, and AbuseIPDB's reports when you add its key.", address: false },
] as const;
export type ShieldCheck = (typeof SHIELD_CHECKS)[number]["id"];
export type ShieldAction = "refuse" | "flag" | "off";
export const checkLabel = (id: string) => SHIELD_CHECKS.find((c) => c.id === id)?.label ?? id;
