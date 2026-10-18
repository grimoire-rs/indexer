// `/marketplace/all.json`: the plugin records the shared catalog's search
// loads, the marketplace's counterpart of the package index's `/all.json`.
// A dynamic route so a site with no marketplace emits nothing.
import { data } from "../../lib/data.js";
import { listedPlugins } from "../../lib/plugins.js";

export function getStaticPaths() {
  return data.marketplace ? [{ params: { name: "all" } }] : [];
}

export function GET() {
  return new Response(JSON.stringify(listedPlugins(data).map((plugin) => plugin.record)));
}
