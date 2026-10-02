import {
  ChannelType,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type Message,
} from "discord.js";

/**
 * A plain snapshot of the server, built per request from discord.js's cache
 * (no API calls). Kept as inert data so the tools stay pure and testable.
 */
export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  category: string | null;
  topic: string | null;
  /** False when the bot itself lacks View Channel there. */
  botCanRead: boolean;
}

export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  mentionable: boolean;
  /** Shown separately in the member list. */
  hoisted: boolean;
  /** True for roles Discord manages for a bot or integration. */
  managed: boolean;
  keyPermissions: string[];
}

export interface ServerSnapshot {
  id: string;
  name: string;
  memberCount: number;
  channels: ChannelInfo[];
  roles: RoleInfo[];
  /** Channels omitted because of the cap, not because of permissions. */
  omittedChannels: number;
  askerName: string;
  askerRoles: string[];
}

const MAX_CHANNELS = 250;

/** Permissions worth reporting when someone asks what a role can do. */
const NOTABLE_PERMISSIONS: [bigint, string][] = [
  [PermissionFlagsBits.Administrator, "Administrator"],
  [PermissionFlagsBits.ManageGuild, "Manage Server"],
  [PermissionFlagsBits.ManageRoles, "Manage Roles"],
  [PermissionFlagsBits.ManageChannels, "Manage Channels"],
  [PermissionFlagsBits.ManageMessages, "Manage Messages"],
  [PermissionFlagsBits.ModerateMembers, "Timeout Members"],
  [PermissionFlagsBits.KickMembers, "Kick Members"],
  [PermissionFlagsBits.BanMembers, "Ban Members"],
  [PermissionFlagsBits.MentionEveryone, "Mention @everyone"],
  [PermissionFlagsBits.ManageWebhooks, "Manage Webhooks"],
  [PermissionFlagsBits.ManageEvents, "Manage Events"],
];

function channelTypeName(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.GuildMedia:
      return "media";
    default:
      return "other";
  }
}

function topicOf(channel: GuildBasedChannel): string | null {
  if ("topic" in channel && typeof channel.topic === "string" && channel.topic.trim()) {
    return channel.topic.trim().slice(0, 400);
  }
  return null;
}

/**
 * Build the snapshot for one message.
 *
 * Channels are filtered to those **the person asking** can already see. Without
 * that filter the bot would happily read out the names and topics of private
 * channels to anyone who asked, which is a disclosure the server owner never
 * agreed to.
 */
export function buildServerSnapshot(message: Message): ServerSnapshot | null {
  const guild = message.guild;
  if (!guild) return null;

  const asker = message.member;
  const me = guild.members.me;

  const channels: ChannelInfo[] = [];
  let omittedChannels = 0;

  for (const channel of guild.channels.cache.values()) {
    // Threads are conversations, not channels: listing them buries the real
    // channel list and eats into the cap.
    if (channel.type === ChannelType.GuildCategory || channel.isThread()) continue;

    if (asker) {
      const perms = channel.permissionsFor(asker);
      if (!perms?.has(PermissionFlagsBits.ViewChannel)) continue;
    }

    if (channels.length >= MAX_CHANNELS) {
      omittedChannels++;
      continue;
    }

    channels.push({
      id: channel.id,
      name: channel.name,
      type: channelTypeName(channel.type),
      category: channel.parent?.name ?? null,
      topic: topicOf(channel),
      botCanRead: me ? (channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel) ?? false) : false,
    });
  }

  channels.sort(
    (a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name),
  );

  const roles: RoleInfo[] = [...guild.roles.cache.values()]
    .filter((role) => role.name !== "@everyone")
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      mentionable: role.mentionable,
      hoisted: role.hoist,
      managed: role.managed,
      keyPermissions: NOTABLE_PERMISSIONS.filter(([bit]) => role.permissions.has(bit)).map(
        ([, label]) => label,
      ),
    }));

  return {
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount,
    channels,
    roles,
    omittedChannels,
    askerName: message.member?.displayName ?? message.author.username,
    askerRoles:
      message.member?.roles.cache
        .filter((role) => role.name !== "@everyone")
        .map((role) => role.name) ?? [],
  };
}
