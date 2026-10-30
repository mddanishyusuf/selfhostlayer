"use client";

import { CircleArrowUp02Icon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useState } from "react";
import type { Release } from "@/lib/updates";
import { Icon } from "../icon";
import { UpdateLog, UpdateProgress, useUpdate } from "../maintenance";
import { Modal } from "../modal";
import { Button, FormError } from "../ui";

/** Opens the update dialog from anywhere (the sidebar's Update button). */
export const openUpdateModal = () => window.dispatchEvent(new Event("layer:update"));

/** What's new in the release the sidebar offers, and the update itself. */
export function UpdateModal({ current, release }: { current: string; release: Release }) {
  const [open, setOpen] = useState(false);
  const run = useUpdate();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("layer:update", onOpen);
    return () => window.removeEventListener("layer:update", onOpen);
  }, []);

  return (
    <Modal
      open={open}
      onClose={close}
      label="Update"
      icon={<Icon icon={CircleArrowUp02Icon} size={22} className="text-accent" />}
      title="Update Self Host Layer"
      description={`${current} → ${release.version}${release.date ? ` · ${release.date}` : ""}`}
      footer={
        run.busy ? undefined : (
          <>
            <Button variant="secondary" onClick={close}>
              Not now
            </Button>
            <Button disabled={run.pending} onClick={() => run.begin(release.version)}>
              {run.pending ? "Starting…" : `Update to ${release.version}`}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-3 px-6 py-5" data-testid="update-modal">
        {run.busy ? (
          <UpdateProgress run={run} />
        ) : (
          <>
            {release.notes && (
              <div className="grid gap-1">
                <p className="text-[13px] text-dim">What&apos;s new</p>
                <p className="whitespace-pre-line text-[14px]">{release.notes}</p>
              </div>
            )}
            <p className="text-[13px] text-muted">Your apps keep running. The update replaces the panel, the agent and the CLI, and the panel restarts on the way: about a minute.</p>
          </>
        )}
        <FormError message={run.error} />
        {run.phase === "failed" && <UpdateLog lines={run.log} />}
      </div>
    </Modal>
  );
}
