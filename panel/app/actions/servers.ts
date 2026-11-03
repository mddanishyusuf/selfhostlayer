"use server";

import { revalidatePath } from "next/cache";
import { agent } from "@/lib/agent";
import { boxConfig } from "@/lib/box";
import { moveProject, removeOldCopy } from "@/lib/move";
import { getProjectBySlug } from "@/lib/projects";
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

/** Updates another server to this panel's own version (its agent runs the installer from its feed, staying agent-only). */
export async function updateServerAction(_prev: ServerFormState, form: FormData): Promise<ServerFormState> {
  await requireUser();
  const server = getServer(Number(field(form, "id")));
  if (!server) return { error: "That server isn't here any more." };
  const version = boxConfig().version;
  try {
    const r = await agent<{ to: string }>("update.start", { version }, { server: server.id });
    revalidatePath("/servers");
    return { saved: `Updating ${server.name} to ${r.to}: check the connection again in a minute or two.` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export interface MoveState {
  error?: string;
  log?: string;
  done?: boolean;
}

/** Moves a project to another server (lib/move.ts): made, deployed and filled with its data there; the old copy keeps running. */
export async function moveProjectAction(_prev: MoveState, form: FormData): Promise<MoveState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { error: "Project not found." };
  const raw = field(form, "server");
  const target = raw === "here" ? null : Number(raw) || null;
  let log = "";
  try {
    await moveProject(project, target, (line) => (log += line));
  } catch (err) {
    return { error: (err as Error).message, log };
  }
  revalidatePath(`/projects/${project.slug}/settings`);
  return { done: true, log };
}

export async function removeOldCopyAction(_prev: MoveState, form: FormData): Promise<MoveState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { error: "Project not found." };
  try {
    await removeOldCopy(project);
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath(`/projects/${project.slug}/settings`);
  return { done: true, log: "The old copy is removed (its data is archived on that server)." };
}
