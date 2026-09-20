import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, matchesKey } from "@earendil-works/pi-tui";
import { t } from "../core/i18n.ts";
import type { SkillUsageStats } from "../modules/skills/types.ts";

export function skillStatsLines(installedSkills: string[], stats: SkillUsageStats[]): string[] {
  if (installedSkills.length === 0) return [t("skills.empty")];
  const counts = new Map(stats.map((item) => [item.skill, item.uses]));
  const nameWidth = Math.min(40, Math.max(5, ...installedSkills.map((name) => name.length)));
  const skillHeader = t("skills.headerSkill");
  const usesHeader = t("skills.headerUses");
  const lines = [
    `${skillHeader.padEnd(nameWidth)}  ${usesHeader}`,
    `${"-".repeat(nameWidth)}  ${"-".repeat(usesHeader.length)}`,
  ];
  for (const skill of installedSkills) {
    const name = skill.length > nameWidth ? `${skill.slice(0, nameWidth - 1)}…` : skill;
    lines.push(`${name.padEnd(nameWidth)}  ${String(counts.get(skill) ?? 0).padStart(4)}`);
  }
  lines.push("", t("skills.installed", { n: installedSkills.length, s: installedSkills.length === 1 ? "" : "s" }));
  return lines;
}

export async function showSkillStats(ctx: ExtensionCommandContext, installedSkills: string[], stats: SkillUsageStats[]): Promise<void> {
  const lines = skillStatsLines(installedSkills, stats);
  const title = t("skills.title");
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`${title}\n${lines.join("\n")}`, "info");
    return;
  }
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(lines.join("\n"), 1, 1));
    container.addChild(new Text(theme.fg("dim", t("close.hint")), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done(); },
    };
  });
}
