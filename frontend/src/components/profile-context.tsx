import { createContext, useContext, type ReactNode } from "react";
import { useResource } from "@/lib/api";
import type { UserProfile } from "@/lib/types";

const ProfileContext = createContext({
  profiles: [] as UserProfile[],
  loading: false,
  error: "",
  reload: () => {},
  update: (_profile: UserProfile) => {},
});

export function ProfileProvider({ children }: { children: ReactNode }) {
  const directory = useResource<UserProfile[]>("/api/users", 60000);
  const profiles = directory.data || [];
  return (
    <ProfileContext.Provider
      value={{
        profiles,
        loading: directory.loading,
        error: directory.error,
        reload: directory.reload,
        update: (profile) =>
          directory.replace([
            ...profiles.filter((item) => item.id !== profile.id),
            profile,
          ]),
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export const useProfiles = () => useContext(ProfileContext);

export function profileImageUrl(profile?: UserProfile) {
  return profile?.image_tag
    ? `/api/users/${encodeURIComponent(profile.id)}/image?tag=${encodeURIComponent(profile.image_tag)}`
    : undefined;
}
