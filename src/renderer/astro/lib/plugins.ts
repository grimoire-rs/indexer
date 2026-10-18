// The plugins the marketplace pages list, as the catalog's own records.
// Shared by the landing page, each plugin's detail page and `all.json`, so the
// three can never disagree about which plugins exist.
import type { MarketplaceMember } from "../../../marketplace/read.js";
import type { GrimoireData, CatalogPackage } from "../../types.js";
import { pluginInstallChoices, type Choice } from "./commands.js";
import { pluginRecord } from "./marketplace.js";

export interface ListedPlugin {
  name: string;
  record: CatalogPackage;
  choices: Choice[];
  members: MarketplaceMember[];
}

/**
 * Every plugin that has at least one install command. A marketplace whose only
 * clients import in a GUI (Cursor) has none, and lists nothing rather than
 * plugins nobody can install from here.
 */
export function listedPlugins({ marketplace }: Pick<GrimoireData, "marketplace">): ListedPlugin[] {
  if (!marketplace) return [];
  return marketplace.plugins.flatMap((plugin) => {
    const choices = pluginInstallChoices(marketplace.clients, plugin.name, marketplace.name);
    return choices.length > 0
      ? [{ name: plugin.name, record: pluginRecord(marketplace.name, plugin), choices, members: plugin.members }]
      : [];
  });
}
