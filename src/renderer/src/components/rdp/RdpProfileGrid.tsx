import { Button, Card, Tooltip } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDesktop, faPen, faTrash } from "@fortawesome/free-solid-svg-icons";
import type { RdpProfile, RdpTab } from "../../../../shared/rdp-contracts";
import { useApplicationContextMenuScope } from "../ApplicationContextMenu";

interface RdpProfileGridProps {
  readonly profiles: readonly RdpProfile[];
  readonly tabs: readonly RdpTab[];
  readonly disabled: boolean;
  readonly onConnect: (profile: RdpProfile) => void;
  readonly onEdit: (profile: RdpProfile) => void;
  readonly onDelete: (profile: RdpProfile) => void;
}

export function RdpProfileGrid({ profiles, tabs, disabled, onConnect, onEdit, onDelete }: RdpProfileGridProps): React.JSX.Element {
  if (profiles.length === 0) {
    return <p className="py-4 text-sm text-muted">Save a connection profile to find it here. A preview appears after your first session.</p>;
  }

  return <div className="rdp-profile-grid">
    {profiles.map((profile) => {
      const connected = tabs.some((tab) => tab.profileId === profile.id && tab.state === "active" &&
        tab.host.toLowerCase() === profile.host.toLowerCase() && tab.port === profile.port &&
        tab.username === profile.username && tab.domain === profile.domain &&
        (tab.signInMode ?? "nla") === (profile.signInMode ?? "nla"));
      return <RdpProfileCard key={profile.id} profile={profile} connected={connected} disabled={disabled} onConnect={onConnect} onEdit={onEdit} onDelete={onDelete} />;
    })}
  </div>;
}

function RdpProfileCard({ profile, connected, disabled, onConnect, onEdit, onDelete }: Pick<RdpProfileGridProps, "disabled" | "onConnect" | "onEdit" | "onDelete"> & {
  readonly profile: RdpProfile;
  readonly connected: boolean;
}): React.JSX.Element {
  const connect = (): void => { if (!disabled) onConnect(profile); };
  const scope = useApplicationContextMenuScope({
    builtInPolicy: "inspect-only",
    actions: [
      { id: "rdp-profile.connect", label: "Connect", icon: faDesktop, isDisabled: disabled, onAction: connect },
      { id: "rdp-profile.edit", label: "Edit", icon: faPen, onAction: () => onEdit(profile) },
      { id: "rdp-profile.delete", label: "Delete", icon: faTrash, variant: "danger", separatorBefore: true, onAction: () => onDelete(profile) },
    ],
  });
  const account = profile.signInMode === "remote-screen" ? "Sign in on the remote screen" : profile.domain ? `${profile.domain}\\${profile.username}` : profile.username;
  return <Card {...scope} className="rdp-profile-card" data-connected={connected} data-has-preview={Boolean(profile.preview)}>
    {profile.preview ? <img
      className="rdp-profile-card__image"
      src={profile.preview.dataUrl}
      alt={`Last saved desktop for ${profile.label}`}
      loading="lazy"
      draggable={false}
    /> : <div className="rdp-profile-card__placeholder">
      <FontAwesomeIcon aria-hidden icon={faDesktop} />
      <span>No preview yet</span>
    </div>}
    {/* Keep focus and the native context menu available when only Connect is disabled. */}
    <Button
      className="rdp-profile-card__connect"
      variant="ghost"
      aria-label={`Connect to ${profile.label}`}
      aria-disabled={disabled}
      onPress={connect}
    >
      <span className="rdp-profile-card__badge">
        {connected && <span className="rdp-profile-card__status" />}
        {connected ? "Connected" : "PC connection"}
      </span>
      <span className="rdp-profile-card__identity">
        <span className="rdp-profile-card__name" title={profile.label}>{profile.label}</span>
        <span className="rdp-profile-card__account" title={account}>{account || "No credentials"}</span>
        <span className="rdp-profile-card__host" title={`${profile.host}:${profile.port}`}>{profile.host}{profile.port !== 3389 ? `:${profile.port}` : ""}</span>
      </span>
    </Button>
    <Tooltip delay={250}>
      <Button
        className="rdp-profile-card__delete"
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={`Delete ${profile.label}`}
        onPress={() => onDelete(profile)}
      ><FontAwesomeIcon aria-hidden icon={faTrash} /></Button>
      <Tooltip.Content>Delete {profile.label}</Tooltip.Content>
    </Tooltip>
  </Card>;
}
