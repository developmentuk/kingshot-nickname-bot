require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} = require("discord.js");
const { initDb } = require("./db");
const cfg = require("./config.json");

const db = initDb();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

// ---------- helpers ----------
function jsonParseSafe(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function hasBypass(member) {
  return cfg.bypassRoleNames.some(rn => member.roles.cache.some(r => r.name === rn));
}

function findVerifiedRole(guild) {
  return guild.roles.cache.find(r => r.name === cfg.verifiedRoleName) || null;
}

function findLogChannel(guild) {
  return guild.channels.cache.find(c => c.name === cfg.logChannelName) || null;
}

function getAllianceForMember(guildId, member) {
  // Returns first matching enabled alliance based on roles
  const rows = db.prepare(
    "SELECT * FROM alliances WHERE guild_id=? AND enabled=1"
  ).all(guildId);

  for (const row of rows) {
    if (member.roles.cache.has(row.role_id)) return row;
  }
  return null;
}

function renderNick(template, alliancePrefix, ign) {
  return template
    .replace("{ALLIANCE}", alliancePrefix)
    .replace("{IGN}", ign);
}

async function safeSetNick(member, nick) {
  // Discord nickname max length 32
  const trimmed = nick.slice(0, 32);
  try {
    await member.setNickname(trimmed, "Kingshot nickname policy");
    return true;
  } catch {
    return false;
  }
}

function upsertMemberIgn(guildId, userId, ign) {
  db.prepare(`
    INSERT INTO members (guild_id, user_id, ign, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(guild_id, user_id)
    DO UPDATE SET ign=excluded.ign, updated_at=excluded.updated_at
  `).run(guildId, userId, ign);
}

function getMemberIgn(guildId, userId) {
  const row = db.prepare("SELECT ign FROM members WHERE guild_id=? AND user_id=?")
    .get(guildId, userId);
  return row?.ign || null;
}

function setRequest(guildId, requestId, userId, roleId, ign) {
  db.prepare(`
    INSERT INTO requests (guild_id, request_id, user_id, role_id, ign, status)
    VALUES (?, ?, ?, ?, ?, 'PENDING')
  `).run(guildId, requestId, userId, roleId, ign);
}

function decideRequest(guildId, requestId, status, decidedBy) {
  db.prepare(`
    UPDATE requests
    SET status=?, decided_by=?, decided_at=strftime('%s','now')
    WHERE guild_id=? AND request_id=?
  `).run(status, decidedBy, guildId, requestId);
}

function getRequest(guildId, requestId) {
  return db.prepare(`
    SELECT * FROM requests WHERE guild_id=? AND request_id=?
  `).get(guildId, requestId);
}

function guildAllianceRow(guildId, roleId) {
  return db.prepare(`
    SELECT * FROM alliances WHERE guild_id=? AND role_id=?
  `).get(guildId, roleId);
}

function isApprover(member, allianceRow) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const allowedRoleIds = jsonParseSafe(allianceRow.approver_role_ids, []);
  if (allowedRoleIds.length === 0) {
    // If none configured, default to members who have the alliance role itself
    return member.roles.cache.has(allianceRow.role_id);
  }
  return allowedRoleIds.some(rid => member.roles.cache.has(rid));
}

async function audit(guild, msg) {
  const ch = findLogChannel(guild);
  if (ch) ch.send({ content: msg }).catch(() => {});
}

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("alliance-add")
    .setDescription("Add an alliance mapping: role → prefix → approval channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName("role").setDescription("Alliance role").setRequired(true))
    .addStringOption(o => o.setName("prefix").setDescription("Prefix shown in nickname, e.g. TLG").setRequired(true))
    .addChannelOption(o => o.setName("channel").setDescription("Approval channel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("alliance-edit")
    .setDescription("Edit an alliance mapping")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName("role").setDescription("Alliance role").setRequired(true))
    .addStringOption(o => o.setName("prefix").setDescription("New prefix, e.g. TLG").setRequired(false))
    .addChannelOption(o => o.setName("channel").setDescription("New approval channel").setRequired(false))
    .addBooleanOption(o => o.setName("enabled").setDescription("Enable/disable").setRequired(false)),

  new SlashCommandBuilder()
    .setName("alliance-approvers")
    .setDescription("Set approver roles for an alliance (optional). If empty, alliance role can approve.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName("role").setDescription("Alliance role").setRequired(true))
    .addStringOption(o => o.setName("approver_role_ids").setDescription("Comma-separated role IDs").setRequired(true)),

  new SlashCommandBuilder()
    .setName("alliance-list")
    .setDescription("List configured alliances")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Prompt a user to submit IGN and start approval")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
].map(c => c.toJSON());

// ---------- register commands on startup ----------
client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  // Register globally (can take time to propagate) OR change to guild-only if you prefer.
  // For guild-only faster: Routes.applicationGuildCommands(client.user.id, GUILD_ID)
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

  console.log(`Logged in as ${client.user.tag}`);
});

// ---------- onboarding trigger: role added ----------
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    if (!newMember?.guild) return;
    if (hasBypass(newMember)) return;

    // if a new role was added that matches an alliance, prompt
    const oldRoles = new Set(oldMember.roles.cache.keys());
    const newRoles = new Set(newMember.roles.cache.keys());

    const added = [...newRoles].filter(rid => !oldRoles.has(rid));
    if (added.length === 0) {
      // optionally enforce nickname if user manually changed it
      if (cfg.enforceOnManualNickChange) {
        const alliance = getAllianceForMember(newMember.guild.id, newMember);
        if (!alliance) return;

        const ign = getMemberIgn(newMember.guild.id, newMember.id);
        if (!ign) return;

        const expected = renderNick(cfg.nickTemplate, alliance.prefix, ign);
        // if differs, reapply (avoid loop if already correct)
        if ((newMember.nickname || newMember.user.username) !== expected) {
          const ok = await safeSetNick(newMember, expected);
          if (ok) await audit(newMember.guild, `🔁 Re-applied nickname for <@${newMember.id}> → \`${expected}\``);
        }
      }
      return;
    }

    // Does any added role match a configured alliance?
    const row = added
      .map(rid => guildAllianceRow(newMember.guild.id, rid))
      .find(r => r && r.enabled === 1);

    if (!row) return;

    // Prompt user for IGN via DM button (fallback: mention in a log channel if DMs closed)
    const ignModalId = `ign_modal_${newMember.guild.id}_${newMember.id}_${row.role_id}`;
    const buttonId = `open_ign_${newMember.guild.id}_${newMember.id}_${row.role_id}`;

    const embed = new EmbedBuilder()
      .setTitle("Kingshot verification")
      .setDescription(`You’ve been given the **${newMember.guild.roles.cache.get(row.role_id)?.name || "alliance"}** role.\n\nPlease submit your **in-game name (IGN)** so we can set your nickname as:\n\`${row.prefix} | YOUR_IGN\``);

    const rowButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buttonId)
        .setLabel("Submit IGN")
        .setStyle(ButtonStyle.Primary)
    );

    const dm = await newMember.createDM().catch(() => null);
    if (dm) {
      await dm.send({ embeds: [embed], components: [rowButtons] }).catch(() => {});
    } else {
      await audit(newMember.guild, `⚠️ Could not DM <@${newMember.id}> to collect IGN (DMs closed). Use /verify.`);
    }
  } catch (e) {
    // swallow errors to avoid spam
  }
});

// ---------- interactions: slash + buttons + modals ----------
client.on("interactionCreate", async (interaction) => {
  try {
    // --- Slash commands ---
    if (interaction.isChatInputCommand()) {
      const g = interaction.guild;
      if (!g) return;

      if (interaction.commandName === "alliance-add") {
        const role = interaction.options.getRole("role", true);
        const prefix = interaction.options.getString("prefix", true);
        const channel = interaction.options.getChannel("channel", true);

        db.prepare(`
          INSERT INTO alliances (guild_id, role_id, prefix, approval_channel_id, enabled)
          VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(guild_id, role_id)
          DO UPDATE SET prefix=excluded.prefix, approval_channel_id=excluded.approval_channel_id, enabled=1
        `).run(g.id, role.id, prefix, channel.id);

        await interaction.reply({ content: `✅ Alliance saved: ${role} → prefix \`${prefix}\` → approvals ${channel}`, ephemeral: true });
        await audit(g, `🛠️ ${interaction.user.tag} updated alliance ${role.name} (prefix: ${prefix}, channel: #${channel.name})`);
        return;
      }

      if (interaction.commandName === "alliance-edit") {
        const role = interaction.options.getRole("role", true);
        const prefix = interaction.options.getString("prefix", false);
        const channel = interaction.options.getChannel("channel", false);
        const enabled = interaction.options.getBoolean("enabled", false);

        const existing = guildAllianceRow(g.id, role.id);
        if (!existing) {
          await interaction.reply({ content: `❌ No alliance mapping exists for ${role}. Use /alliance-add.`, ephemeral: true });
          return;
        }

        const newPrefix = prefix ?? existing.prefix;
        const newChannelId = channel?.id ?? existing.approval_channel_id;
        const newEnabled = (enabled === null || enabled === undefined) ? existing.enabled : (enabled ? 1 : 0);

        db.prepare(`
          UPDATE alliances
          SET prefix=?, approval_channel_id=?, enabled=?
          WHERE guild_id=? AND role_id=?
        `).run(newPrefix, newChannelId, newEnabled, g.id, role.id);

        await interaction.reply({ content: `✅ Updated ${role}: prefix \`${newPrefix}\`, channel <#${newChannelId}>, enabled=${newEnabled === 1}`, ephemeral: true });
        await audit(g, `🛠️ ${interaction.user.tag} edited alliance ${role.name}`);
        return;
      }

      if (interaction.commandName === "alliance-approvers") {
        const role = interaction.options.getRole("role", true);
        const list = interaction.options.getString("approver_role_ids", true)
          .split(",")
          .map(s => s.trim())
          .filter(Boolean);

        const existing = guildAllianceRow(g.id, role.id);
        if (!existing) {
          await interaction.reply({ content: `❌ No alliance mapping exists for ${role}. Use /alliance-add first.`, ephemeral: true });
          return;
        }

        db.prepare(`
          UPDATE alliances
          SET approver_role_ids=?
          WHERE guild_id=? AND role_id=?
        `).run(JSON.stringify(list), g.id, role.id);

        await interaction.reply({
          content: `✅ Approvers set for ${role}.\nIf you set an empty list, anyone with the alliance role can approve.`,
          ephemeral: true
        });
        await audit(g, `🛠️ ${interaction.user.tag} set approvers for ${role.name} (${list.length} role IDs)`);
        return;
      }

      if (interaction.commandName === "alliance-list") {
        const rows = db.prepare("SELECT * FROM alliances WHERE guild_id=?").all(g.id);
        if (rows.length === 0) {
          await interaction.reply({ content: "No alliances configured yet.", ephemeral: true });
          return;
        }

        const lines = rows.map(r => {
          const role = g.roles.cache.get(r.role_id);
          return `• ${role ? role.name : r.role_id} → \`${r.prefix}\` → <#${r.approval_channel_id}> → enabled=${r.enabled === 1}`;
        });

        await interaction.reply({ content: lines.join("\n"), ephemeral: true });
        return;
      }

      if (interaction.commandName === "verify") {
        const user = interaction.options.getUser("user", true);
        const member = await g.members.fetch(user.id).catch(() => null);
        if (!member) {
          await interaction.reply({ content: "❌ Member not found.", ephemeral: true });
          return;
        }

        const alliance = getAllianceForMember(g.id, member);
        if (!alliance) {
          await interaction.reply({ content: "❌ That user has no configured alliance role yet.", ephemeral: true });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`ign_modal_${g.id}_${member.id}_${alliance.role_id}`)
          .setTitle("Enter your Kingshot IGN");

        const ignInput = new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("In-game name (IGN)")
          .setPlaceholder("e.g., Nexus")
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(20)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(ignInput));

        await interaction.showModal(modal);
        return;
      }
    }

    // --- Buttons ---
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Open IGN modal (from DM or server)
      if (id.startsWith("open_ign_")) {
        const [, guildId, userId, roleId] = id.split("_");
        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "This button isn’t for you.", ephemeral: true });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`ign_modal_${guildId}_${userId}_${roleId}`)
          .setTitle("Enter your Kingshot IGN");

        const ignInput = new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("In-game name (IGN)")
          .setPlaceholder("e.g., Nexus")
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(20)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(ignInput));
        await interaction.showModal(modal);
        return;
      }

      // Approvals: approve/reject
      if (id.startsWith("req_approve_") || id.startsWith("req_reject_")) {
        const parts = id.split("_");
        const action = parts[1]; // approve/reject
        const guildId = parts[2];
        const requestId = parts.slice(3).join("_");

        const g = interaction.guild;
        if (!g || g.id !== guildId) {
          await interaction.reply({ content: "Invalid guild context.", ephemeral: true });
          return;
        }

        const req = getRequest(g.id, requestId);
        if (!req) {
          await interaction.reply({ content: "❌ Request not found.", ephemeral: true });
          return;
        }
        if (req.status !== "PENDING") {
          await interaction.reply({ content: `This request is already **${req.status}**.`, ephemeral: true });
          return;
        }

        const alliance = guildAllianceRow(g.id, req.role_id);
        if (!alliance) {
          await interaction.reply({ content: "❌ Alliance mapping missing for this request.", ephemeral: true });
          return;
        }

        const memberApprover = await g.members.fetch(interaction.user.id).catch(() => null);
        if (!memberApprover || !isApprover(memberApprover, alliance)) {
          await interaction.reply({ content: "❌ You don’t have permission to approve this request.", ephemeral: true });
          return;
        }

        const target = await g.members.fetch(req.user_id).catch(() => null);
        if (!target) {
          await interaction.reply({ content: "❌ User no longer in server.", ephemeral: true });
          decideRequest(g.id, requestId, "REJECTED", interaction.user.id);
          return;
        }

        if (action === "approve") {
          upsertMemberIgn(g.id, target.id, req.ign);

          // Apply nickname
          const nick = renderNick(cfg.nickTemplate, alliance.prefix, req.ign);
          const ok = await safeSetNick(target, nick);

          // Optional: add Verified role
          const verified = findVerifiedRole(g);
          if (verified) {
            await target.roles.add(verified).catch(() => {});
          }

          decideRequest(g.id, requestId, "APPROVED", interaction.user.id);

          const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0] ?? new EmbedBuilder())
            .setFooter({ text: `✅ Approved by ${interaction.user.tag}` });

          await interaction.update({
            embeds: [updatedEmbed],
            components: []
          });

          await target.send(`✅ You’ve been verified. Your nickname has been set to: \`${nick}\``).catch(() => {});
          await audit(g, `✅ Approved <@${target.id}> IGN=\`${req.ign}\` nickSet=${ok}`);
          return;
        }

        if (action === "reject") {
          decideRequest(g.id, requestId, "REJECTED", interaction.user.id);

          const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0] ?? new EmbedBuilder())
            .setFooter({ text: `❌ Rejected by ${interaction.user.tag}` });

          await interaction.update({
            embeds: [updatedEmbed],
            components: []
          });

          await audit(g, `❌ Rejected <@${req.user_id}> IGN=\`${req.ign}\``);
          return;
        }
      }
    }

    // --- Modals ---
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      if (id.startsWith("ign_modal_")) {
        const [, guildId, userId, roleId] = id.split("_");

        const ign = interaction.fields.getTextInputValue("ign").trim();

        // Basic sanitisation (optional)
        if (ign.length < 2 || ign.length > 20) {
          await interaction.reply({ content: "IGN must be 2–20 characters.", ephemeral: true });
          return;
        }

        // Try to locate guild context
        const g = client.guilds.cache.get(guildId) || interaction.guild;
        if (!g) {
          await interaction.reply({ content: "Could not find guild context.", ephemeral: true });
          return;
        }

        const alliance = guildAllianceRow(g.id, roleId);
        if (!alliance || alliance.enabled !== 1) {
          await interaction.reply({ content: "That alliance mapping is missing or disabled.", ephemeral: true });
          return;
        }

        // Create request + post to approval channel
        const requestId = `${Date.now()}_${userId}`;
        setRequest(g.id, requestId, userId, roleId, ign);

        const approvalChannel = g.channels.cache.get(alliance.approval_channel_id);
        if (!approvalChannel || !approvalChannel.isTextBased()) {
          await interaction.reply({ content: "Approval channel not found / not text-based. Tell an admin to fix it.", ephemeral: true });
          return;
        }

        const roleName = g.roles.cache.get(roleId)?.name ?? "Alliance";
        const embed = new EmbedBuilder()
          .setTitle("IGN Approval Request")
          .setDescription(
            `**User:** <@${userId}>\n` +
            `**Alliance role:** ${roleName}\n` +
            `**Requested IGN:** \`${ign}\`\n\n` +
            `If approved, nickname will become:\n` +
            `\`${renderNick(cfg.nickTemplate, alliance.prefix, ign)}\``
          )
          .setTimestamp(new Date());

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_approve_${g.id}_${requestId}`)
            .setLabel("Approve")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_${g.id}_${requestId}`)
            .setLabel("Reject")
            .setStyle(ButtonStyle.Danger)
        );

        await approvalChannel.send({ embeds: [embed], components: [buttons] });

        await interaction.reply({ content: "✅ Submitted! Your alliance leadership will approve it shortly.", ephemeral: true });
        await audit(g, `📥 IGN submitted by <@${userId}> for role ${roleName}: \`${ign}\``);
        return;
      }
    }
  } catch (e) {
    try {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "Something went wrong handling that action.", ephemeral: true });
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
