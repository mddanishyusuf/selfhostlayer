import { previewImage } from "@/lib/preview";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The live site's preview image, saved by lib/preview (the Overview links it with ?v=<deployment>). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return new Response("unauthorized", { status: 401 });
  const image = previewImage((await params).slug);
  if (!image) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(image.body), {
    headers: { "Content-Type": image.type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}
