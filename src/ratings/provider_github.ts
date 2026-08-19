// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * GitHub Discussions — GraphQL only, no REST equivalent.
 *
 * Upvotes are first-class here: `upvoteCount` is a scalar on the discussion, so
 * the tally costs ~1 GraphQL point per page. Counting `reactionGroups` nodes
 * instead would multiply nested-node cost for the same number.
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

const CATEGORIES = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    id
    discussionCategories(first:100){nodes{id name}}
  }
}`;

// `databaseId` rather than the node `id`: R-1 clause 2 compares against
// `index-policy.json`'s `trustedBots[].id`, which is the numeric account id the
// validate gate already writes there — the opaque node id would never match.
const DISCUSSIONS = `
query($owner:String!,$name:String!,$categoryId:ID!,$cursor:String){
  repository(owner:$owner,name:$name){
    discussions(first:${PAGE_SIZE},after:$cursor,categoryId:$categoryId){
      pageInfo{hasNextPage endCursor}
      nodes{
        id url upvoteCount body
        category{id}
        repository{id}
        author{...on User{databaseId} ...on Bot{databaseId}}
      }
    }
  }
}`;

const CREATE = `
mutation($repositoryId:ID!,$categoryId:ID!,$title:String!,$body:String!){
  createDiscussion(input:{repositoryId:$repositoryId,categoryId:$categoryId,title:$title,body:$body}){
    discussion{id url upvoteCount}
  }
}`;

const LOCK = `
mutation($lockableId:ID!){
  lockLockable(input:{lockableId:$lockableId}){clientMutationId}
}`;

export function githubProvider(config: RatingProviderConfig): RatingProvider {
  const headers = { Authorization: `Bearer ${config.token}` };
  const [owner = "", name = ""] = config.project.split("/", 2);

  let resolved: { repositoryId: string; categoryId: string } | null = null;

  /** `container` is a name the operator typed; R-1 compares ids, so resolve it once. */
  async function resolve(): Promise<{ repositoryId: string; categoryId: string }> {
    if (resolved) return resolved;
    const data = await graphql(config.api, headers, CATEGORIES, { owner, name });
    const repositoryId = stringAt(data, "repository", "id");
    if (repositoryId === "") {
      throw new ForgeError(`${config.project}: no such repository, or it is not visible to this token`);
    }
    const wanted = config.container.trim().toLowerCase();
    const categories = nodes(at(data, "repository", "discussionCategories"));
    const match = categories.find((node) => stringAt(node, "name").trim().toLowerCase() === wanted);
    if (!match) {
      throw new ForgeError(
        `${config.project}: no discussion category named ${JSON.stringify(config.container)} ` +
          `(found: ${categories.map((node) => stringAt(node, "name")).join(", ") || "none"})`,
        // The operator's `container` is wrong, not the forge — a data error, so
        // a retry on the next schedule cannot fix it and should not pretend to.
        EXIT.data,
      );
    }
    resolved = { repositoryId, categoryId: stringAt(match, "id") };
    return resolved;
  }

  return {
    async listAuthored() {
      const { repositoryId, categoryId } = await resolve();
      const threads: RatingThread[] = [];
      let cursor: string | null = null;

      for (;;) {
        const data = await graphql(
          config.api,
          headers,
          DISCUSSIONS,
          { owner, name, categoryId, cursor },
          threads,
        );
        const page = at(data, "repository", "discussions");
        for (const node of nodes(page)) {
          const author = at(node, "author");
          const databaseId = at(author, "databaseId");
          const observed: ObservedThread = {
            target: stringAt(node, "id"),
            url: stringAt(node, "url"),
            up: typeof at(node, "upvoteCount") === "number" ? (at(node, "upvoteCount") as number) : 0,
            body: stringAt(node, "body"),
            authorId: typeof databaseId === "number" ? String(databaseId) : undefined,
            containerId: stringAt(node, "repository", "id"),
            categoryId: stringAt(node, "category", "id"),
          };
          const authorized = authorizeThread(observed, {
            trustedBots: config.trustedBots,
            containerId: repositoryId,
            categoryId,
          });
          if (authorized) threads.push(authorized);
        }
        if (at(page, "pageInfo", "hasNextPage") !== true) return threads;
        cursor = stringAt(page, "pageInfo", "endCursor");
      }
    },

    async create(ref) {
      const { repositoryId, categoryId } = await resolve();
      const data = await graphql(config.api, headers, CREATE, {
        repositoryId,
        categoryId,
        title: ref,
        body: threadBody(ref),
      });
      const discussion = at(data, "createDiscussion", "discussion");
      const target = stringAt(discussion, "id");
      if (target === "") throw new ForgeError(`${config.project}: createDiscussion returned no discussion`);

      // Locking is the promise `lockThreads: true` makes — votes count, replies
      // are refused — so a failure here fails the run rather than silently
      // leaving an open forum the operator did not ask to moderate. Turn it off
      // in `index.config.json` if the forge cannot honour it.
      if (config.lockThreads) {
        await graphql(config.api, headers, LOCK, { lockableId: target });
      }

      return {
        ref,
        target,
        url: stringAt(discussion, "url"),
        up: typeof at(discussion, "upvoteCount") === "number" ? (at(discussion, "upvoteCount") as number) : 0,
      };
    },
  };
}
