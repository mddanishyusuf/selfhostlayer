"use server";

import { revalidatePath } from "next/cache";
import { agent } from "@/lib/agent";
import { requireUser } from "@/lib/session";
import { addServer, getServer, recordCheck, removeServer, type ServerInfo } from "@/lib/servers";

export interface ServerFormState {
  error?: string;
  saved?: string;
  /** The server just added: its page shows the install command. */
  added?: number;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function addServerAction(_prev: ServerFormState, form: FormData): Promise<ServerFormState> {
  await requireUser();
  try {
    const s = addServer(field(form, "name"), field(form, "host").toLowerCase(), Number(field(form, "port") || 22));
    revalidatePath("/servers");
    return { added: s.id, saved: `${s.name} is added: run the command below on it, as root.` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Asks the server's agent about itself, over the panel's SSH link. */
export async function checkServerAction(_prev: ServerFormState, form: FormData): Promise<ServerFormState> {
  await requireUser();
  const server = getServer(Number(field(form, "id")));
  if (!server) return { error: "That server isn't here any more." };
  try {
    const info = await agent<ServerInfo>("system.info", {}, { server: server.id });
    recordCheck(server.id, { info });
    revalidatePath("/servers");
    return { saved: `Connected: ${info.os.name}, agent ${info.agentVersion}.` };
  } catch (err) {
    const message = (err as Error).message;
    recordCheck(server.id, { error: message });
    revalidatePath("/servers");
    return { error: `Couldn't reach its agent: ${message}` };
  }
}

export async function removeServerAction(_prev: ServerFormState, form: FormData): Promise<ServerFormState> {
  await requireUser();
  const server = getServer(Number(field(form, "id")));
  if (!server) return { error: "That server isn't here any more." };
  if (field(form, "confirm") !== server.name) return { error: `Type ${server.name} to confirm.` };
  try {
    removeServer(server.id);
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath("/servers");
  return { saved: `${server.name} is removed from the panel. Its apps and agent are still on it.` };
}
