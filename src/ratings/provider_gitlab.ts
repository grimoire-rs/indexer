// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * GitLab work items — the GraphQL surface, not the long-term-deprecated REST
 * issues API.
 *
 * The counter lives on the **Emoji Reactions** widget (`upvotes`). GitLab
 * renamed the feature from Award Emoji in 16.0 while leaving the GraphQL names
 * (`AwardEmoji`, `awardEmojiToggle`) unchanged, so the schema below reads
 * legacy and the prose reads current — that is the rename, not a mismatch.
 */

import { authorizeThread, type ObservedThread } from "./marker.js";
import {
  ForgeError,
  PAGE_SIZE,
  at,
  graphql,
  nodes,
  threadBody,
  stringAt,
  type RatingProvider,
  type RatingProviderConfig,
  type RatingThread,
} from "./provider.js";
import { EXIT } from "../cli/exit.js";

const TYPES = `
query($path:ID!){
  project(fullPath:$path){
    id
    workItemTypes{nodes{id name}}
  }
}`;

const WORK_ITEMS = `
query($path:ID!,$types:[IssueType!],$cursor:String){
  project(fullPath:$path){
    id
    workItems(first:${PAGE_SIZE},after:$cursor,types:$types){
      pageInfo{hasNextPage endCursor}
      nodes{
        id webUrl
        author{id}
        workItemType{id}
        widgets{
          ...on WorkItemWidgetDescription{description}
          ...on WorkItemWidgetAwardEmoji{upvotes}
        }
      }
    }
  }
}`;

const CREATE = `
mutation($path:ID!,$typeId:WorkItemsTypeID!,$title:String!,$body:String!){
  workItemCreate(input:{namespacePath:$path,workItemTypeId:$typeId,title:$title,descriptionWidget:{description:$body}}){
    workItem{id webUrl}
  }
}`;

const LOCK = `
mutation($id:WorkItemID!){
  workItemUpdate(input:{id:$id,notesWidget:{discussionLocked:true}}){
    workItem{id}
  }
}`;

/**
 * The numeric tail of a global id — `gid://gitlab/User/42` → `42`.
 *
 * Only the **author** id is normalized, and only because R-1 clause 2 compares
 * it against `index-policy.json`'s `trustedBots[].id`, which the validate gate
 * writes as GitLab's numeric user id. Container and type ids stay whole gids:
 * both sides of those comparisons come from this same provider, so there is
 * nothing to agree with.
 */
function numericId(gid: string): string | undefined {
  const tail = gid.split("/").pop();
  return tail !== undefined && /^\d+$/.test(tail) ? tail : undefined;
}

/** `Issue` → `ISSUE`, `Test case` → `TEST_CASE`. The `types:` filter's enum. */
function typeEnum(container: string): string {
  return container.trim().toUpperCase().replace(/\s+/g, "_");
}

export function gitlabProvider(config: RatingProviderConfig): RatingProvider {
  const headers = { Authorization: `Bearer ${config.token}` };
  const path = config.project;

  let resolved: { projectId: string; typeId: string } | null = null;

  async function resolve(): Promise<{ projectId: string; typeId: string }> {
    if (resolved) return resolved;
    const data = await graphql(config.api, headers, TYPES, { path });
    const projectId = stringAt(data, "project", "id");
    if (projectId === "") {
      throw new ForgeError(`${path}: no such project, or it is not visible to this token`);
    }
    const wanted = config.container.trim().toLowerCase();
    const types = nodes(at(data, "project", "workItemTypes"));
    const match = types.find((node) => stringAt(node, "name").trim().toLowerCase() === wanted);
    if (!match) {
      throw new ForgeError(
        `${path}: no work item type named ${JSON.stringify(config.container)} ` +
          `(found: ${types.map((node) => stringAt(node, "name")).join(", ") || "none"})`,
        EXIT.data,
      );
    }
    resolved = { projectId, typeId: stringAt(match, "id") };
    return resolved;
  }

  return {
    async listAuthored() {
      const { projectId, typeId } = await resolve();
      const threads: RatingThread[] = [];
      let cursor: string | null = null;

      for (;;) {
        const data = await graphql(
          config.api,
          headers,
          WORK_ITEMS,
          { path, types: [typeEnum(config.container)], cursor },
          threads,
        );
        const page = at(data, "project", "workItems");
        for (const node of nodes(page)) {
          const widgets = at(node, "widgets");
          const list = Array.isArray(widgets) ? widgets : [];
          const upvotes = list.map((w) => at(w, "upvotes")).find((v) => typeof v === "number");
          const description = list.map((w) => at(w, "description")).find((v) => typeof v === "string");
          const observed: ObservedThread = {
            target: stringAt(node, "id"),
            url: stringAt(node, "webUrl"),
            up: typeof upvotes === "number" ? upvotes : 0,
            body: typeof description === "string" ? description : "",
            authorId: numericId(stringAt(node, "author", "id")),
            // The query is scoped to this project, so every node it returns is
            // in it. R-1 clause 4 still compares — the rule lives in one place.
            containerId: projectId,
            categoryId: stringAt(node, "workItemType", "id"),
          };
          const authorized = authorizeThread(observed, {
            trustedBots: config.trustedBots,
            containerId: projectId,
            categoryId: typeId,
          });
          if (authorized) threads.push(authorized);
        }
        if (at(page, "pageInfo", "hasNextPage") !== true) return threads;
        cursor = stringAt(page, "pageInfo", "endCursor");
      }
    },

    async create(ref) {
      const { typeId } = await resolve();
      const data = await graphql(config.api, headers, CREATE, {
        path,
        typeId,
        title: ref,
        body: threadBody(ref),
      });
      const item = at(data, "workItemCreate", "workItem");
      const target = stringAt(item, "id");
      if (target === "") throw new ForgeError(`${path}: workItemCreate returned no work item`);

      // Same contract as the GitHub side: `lockThreads: true` promises replies
      // are refused, so failing to lock fails the run rather than quietly
      // opening a forum the operator did not ask to moderate.
      if (config.lockThreads) {
        await graphql(config.api, headers, LOCK, { id: target });
      }

      // A fresh work item has no reactions, and asking for them would cost a
      // second round trip to learn zero.
      return { ref, target, url: stringAt(item, "webUrl"), up: 0 };
    },
  };
}
