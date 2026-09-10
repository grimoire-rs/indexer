    # Artifactory's own per-artifact download counters. Read is the whole
    # permission needed - `stat.downloads` is not admin-gated - but it must be
    # granted on every repository this index lists: a missing read permission
    # is SILENT in AQL (HTTP 200, no rows, no error), so the command
    # cross-checks the repository list and fails rather than publishing a zero
    # that looks like a fact.
    #
    # Set GRIM_DOWNLOADS_TOKEN as a masked CI/CD variable, to an Artifactory
    # access token with that read. (`downloads.oidcProvider` is GitHub-only -
    # the id-token exchange is one action there and hand-written HTTP here.)
    - npx --no grim-indexer downloads
