import { useEffect, useRef, useState } from "react";
import { Camera, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import type { User, UserProfile } from "@/lib/types";
import { useProfiles } from "@/components/profile-context";
import { Avatar, BusyButton, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProfileDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const directory = useProfiles();
  const profile = directory.profiles.find((item) => item.id === user.id);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function clearFile() {
    setFile(undefined);
    if (input.current) input.current.value = "";
  }
  function chooseFile(selected?: File) {
    setError("");
    setMessage("");
    if (!selected) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type)) {
      clearFile();
      setError("Choose a JPEG, PNG or WebP image");
      return;
    }
    if (selected.size > 5 * 1024 * 1024) {
      clearFile();
      setError("Choose a picture smaller than 5 MB");
      return;
    }
    setFile(selected);
  }
  async function changePicture(remove = false) {
    if (busy || (!remove && !file)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const updated = await api<UserProfile>(
        "/api/me/image",
        remove
          ? { method: "DELETE" }
          : {
              method: "POST",
              headers: { "Content-Type": file!.type },
              body: file,
            },
      );
      directory.update(updated);
      clearFile();
      setMessage(
        remove
          ? "Profile picture removed from Jellyfin."
          : "Profile picture saved to Jellyfin.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to update your picture",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        if (!value) {
          clearFile();
          setError("");
          setMessage("");
        }
        onOpenChange(value);
      }}
    >
      <DialogContent className="profile-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Your profile picture</DialogTitle>
          <DialogDescription>
            Synced with your Jellyfin account. Your picture appears wherever you
            watch, rate or make the leaderboard.
          </DialogDescription>
        </DialogHeader>
        <div className="profile-picture-preview">
          {preview ? (
            <img
              src={preview}
              alt="New profile picture preview"
              onError={() => {
                clearFile();
                setError(
                  "This image could not be opened. Choose another picture.",
                );
              }}
            />
          ) : (
            <Avatar name={user.name} userId={user.id} />
          )}
          <strong>{user.name}</strong>
          <span>
            {file
              ? "Preview · cropped to a square when saved"
              : "Your Jellyfin profile"}
          </span>
        </div>
        {directory.error ? (
          <ErrorState message={directory.error} retry={directory.reload} />
        ) : directory.loading && !profile ? (
          <p className="profile-note" role="status">
            Loading your Jellyfin profile…
          </p>
        ) : !profile?.can_edit_image ? (
          <p className="profile-note">
            Your Jellyfin administrator has disabled profile picture changes.
          </p>
        ) : null}
        {error && <ErrorState message={error} />}
        {message && (
          <p className="profile-note" role="status">
            {message}
          </p>
        )}
        <div className="profile-upload">
          <label htmlFor="profile-picture-file">
            <Camera size={17} /> Choose a picture
          </label>
          <Input
            ref={input}
            id="profile-picture-file"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy || !profile?.can_edit_image}
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />
          <p className="profile-note">
            JPEG, PNG or WebP, up to 5 MB. A square picture works best.
          </p>
        </div>
        <div className="profile-actions">
          <BusyButton
            busy={busy}
            disabled={!file || !profile?.can_edit_image}
            onClick={() => void changePicture()}
          >
            <Upload /> Save picture
          </BusyButton>
          <Button
            variant="outline"
            disabled={busy || !profile?.image_tag || !profile.can_edit_image}
            onClick={() => void changePicture(true)}
          >
            <Trash2 /> Remove picture
          </Button>
        </div>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            clearFile();
            setError("");
            setMessage("");
            onOpenChange(false);
          }}
        >
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}
